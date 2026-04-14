/**
 * NetworkServer — uWebSockets-based WebSocket server.
 *
 * Runs uWS::App on a dedicated thread. The sim thread communicates
 * via a mutex-protected inbound queue (network→sim) and uses
 * uWS::Loop::defer() for outbound messages (sim→network).
 */

#include "NetworkServer.h"
#include "CacheControl.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "net"

// uWebSockets includes
#include <App.h>

#include <cstdio>
#include <string>
#include <string_view>

/// Per-connection user data stored by uWebSockets.
struct ClientData {
    ClientID id;
};

/// Internal state that depends on uWS types (kept out of the header).
struct NetworkServer::Impl {
    // The uWS event loop, used for cross-thread defer()
    struct us_loop_t* loop = nullptr;

    // Listen socket — closed to trigger app.run() exit
    us_listen_socket_t* listenSocket = nullptr;

    // Active WebSocket connections, keyed by ClientID.
    // Only accessed from the network thread.
    struct ClientEntry {
        uWS::WebSocket<false, true, ClientData>* ws;
    };
    std::mutex clientsMutex;
    std::vector<ClientEntry> clients;
    ClientID nextId = 1;

    // Outbound queue (sim thread pushes, network thread drains via defer)
    struct OutboundMessage {
        ClientID targetId;  // 0 = broadcast
        std::vector<uint8_t> data;
    };
    std::mutex outboundMutex;
    std::vector<OutboundMessage> outboundQueue;
};


NetworkServer::NetworkServer() : impl(std::make_unique<Impl>()) {}

NetworkServer::~NetworkServer() {
    Stop();
}

void NetworkServer::AddHttpGet(const std::string& pattern, HttpGetHandler handler) {
    httpGetHandlers.emplace_back(pattern, std::move(handler));
}

void NetworkServer::AddHttpPost(const std::string& pattern, HttpPostHandler handler) {
    httpPostHandlers.emplace_back(pattern, std::move(handler));
}

bool NetworkServer::Start(int port) {
    if (running.load())
        return false;

    running.store(true);
    networkThread = std::thread(&NetworkServer::NetworkThreadFunc, this, port);
    return true;
}

void NetworkServer::Stop() {
    if (!running.load())
        return;

    running.store(false);

    // Wake the uWS loop so it can check the running flag and exit
    if (impl->loop) {
        uWS::Loop::get(impl->loop)->defer([this]() {
            // The preHandler will close sockets and let app.run() exit
        });
    }

    if (networkThread.joinable()) {
        // Re-wake periodically in case the first defer was lost
        std::thread killer([this]() {
            for (int i = 0; i < 20; i++) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
                if (!running.load() && impl->loop) {
                    try { uWS::Loop::get(impl->loop)->defer([](){}); } catch (...) {}
                }
            }
        });
        killer.detach();

        networkThread.join();
    }
}

std::vector<InboundMessage> NetworkServer::DrainInbound() {
    std::lock_guard<std::mutex> lock(inboundMutex);
    std::vector<InboundMessage> drained;
    drained.swap(inboundQueue);
    return drained;
}

std::vector<ClientID> NetworkServer::DrainDisconnects() {
    std::lock_guard<std::mutex> lock(disconnectMutex);
    std::vector<ClientID> drained;
    drained.swap(disconnectQueue);
    return drained;
}

void NetworkServer::Send(ClientID clientId, const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lock(impl->outboundMutex);
    impl->outboundQueue.push_back({clientId, {data, data + len}});

    // Wake the network thread to process outbound
    if (impl->loop) {
        uWS::Loop::get(impl->loop)->defer([]() {});
    }
}

void NetworkServer::Broadcast(const uint8_t* data, size_t len) {
    Send(0, data, len); // ClientID 0 = broadcast
}

void NetworkServer::NetworkThreadFunc(int port) {
    uWS::App app;

    // Direct-register a raw wildcard route to prove uWS wildcards work in
    // this build. If /rawping/foo doesn't 200, something is very wrong.
    SLOG(SPRING_LOG_DEBUG, "registering /rawping/*");
    app.get("/rawping/*", [](auto* res, auto* req) {
        SLOG(SPRING_LOG_DEBUG, "rawping url=%s", std::string(req->getUrl()).c_str());
        res->writeStatus("200 OK");
        res->end("pong");
    });
    SLOG(SPRING_LOG_DEBUG, "/rawping/* registered");

    // Register HTTP GET endpoints from the stored handler list.
    for (auto& [pattern, handler] : httpGetHandlers) {
        app.get(pattern, [&handler](auto* res, auto* req) {
            std::string url(req->getUrl());
            auto result = handler(url);

            res->writeStatus(result.status == 200 ? "200 OK" : "404 Not Found");
            res->writeHeader("Content-Type", result.contentType);
            res->writeHeader("Access-Control-Allow-Origin", "*");
            res->writeHeader("Cache-Control", result.cacheControl);
            res->writeHeader("X-Build-Stamp", CacheControl::BuildStamp());
            std::string_view body(
                reinterpret_cast<const char*>(result.body.data()),
                result.body.size());
            res->end(body);
        });
    }

    // Register HTTP POST endpoints.
    for (auto& [pattern, handler] : httpPostHandlers) {
        app.post(pattern, [&handler](auto* res, auto* req) {
            std::string url(req->getUrl());

            // Capture headers before onData (req is only valid in this callback)
            auto headers = std::make_shared<HttpRequestHeaders>();
            headers->authorization = std::string(req->getHeader("authorization"));
            headers->contentType = std::string(req->getHeader("content-type"));

            // uWS streams POST bodies — buffer the full body
            // before calling the handler.
            res->onData([res, url, &handler, headers, body = std::make_shared<std::string>()](
                            std::string_view chunk, bool isLast) mutable {
                body->append(chunk);
                if (!isLast) return;

                auto result = handler(url, *body, *headers);
                res->writeStatus(result.status == 200 ? "200 OK"
                    : result.status == 400 ? "400 Bad Request"
                    : result.status == 401 ? "401 Unauthorized"
                    : result.status == 404 ? "404 Not Found"
                    : "500 Internal Server Error");
                res->writeHeader("Content-Type", result.contentType);
                res->writeHeader("Access-Control-Allow-Origin", "*");
                res->writeHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res->writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                res->writeHeader("X-Build-Stamp", CacheControl::BuildStamp());
                std::string_view respBody(
                    reinterpret_cast<const char*>(result.body.data()),
                    result.body.size());
                res->end(respBody);
            });
            res->onAborted([]() {});
        });
    }

    // CORS preflight for POST endpoints
    app.options("/*", [](auto* res, auto* /*req*/) {
        res->writeHeader("Access-Control-Allow-Origin", "*");
        res->writeHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res->writeHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res->end();
    });

    app.ws<ClientData>("/*", {
        .compression = uWS::DISABLED,
        .maxPayloadLength = 64 * 1024,  // 64 KB per PLAN-network.md
        .idleTimeout = 120,
        .maxBackpressure = 1024 * 1024,
        .sendPingsAutomatically = true,

        .open = [this](auto* ws) {
            auto* data = ws->getUserData();
            data->id = impl->nextId++;

            {
                std::lock_guard<std::mutex> lock(impl->clientsMutex);
                impl->clients.push_back({ws});
            }
            clientCount.fetch_add(1);

            SLOG(SPRING_LOG_INFO, "client %u connected (%d total)",
                data->id, clientCount.load());
        },

        .message = [this](auto* ws, std::string_view message, uWS::OpCode opCode) {
            if (opCode != uWS::OpCode::BINARY)
                return;

            auto* data = ws->getUserData();

            // Push to inbound queue for the sim thread
            InboundMessage msg;
            msg.clientId = data->id;
            msg.data.assign(
                reinterpret_cast<const uint8_t*>(message.data()),
                reinterpret_cast<const uint8_t*>(message.data()) + message.size()
            );

            {
                std::lock_guard<std::mutex> lock(inboundMutex);
                inboundQueue.push_back(std::move(msg));
            }
        },

        .close = [this](auto* ws, int /*code*/, std::string_view /*message*/) {
            auto* data = ws->getUserData();
            ClientID id = data->id;

            {
                std::lock_guard<std::mutex> lock(impl->clientsMutex);
                auto& clients = impl->clients;
                clients.erase(
                    std::remove_if(clients.begin(), clients.end(),
                        [id](const Impl::ClientEntry& e) {
                            return e.ws->getUserData()->id == id;
                        }),
                    clients.end()
                );
            }
            clientCount.fetch_sub(1);

            // Notify the sim thread so it can fire Lua callins
            {
                std::lock_guard<std::mutex> lock(disconnectMutex);
                disconnectQueue.push_back(id);
            }

            SLOG(SPRING_LOG_INFO, "client %u disconnected (%d remaining)",
                id, clientCount.load());
        },
    });

    app.listen(port, [this, port](auto* listenSocket) {
        impl->listenSocket = listenSocket;
        if (listenSocket) {
            SLOG(SPRING_LOG_NOTICE, "listening on port %d", port);
        } else {
            SLOG(SPRING_LOG_ERROR, "failed to bind port %d", port);
        }
    });

    // Store the loop pointer for cross-thread defer()
    impl->loop = (struct us_loop_t*)uWS::Loop::get();

    // Set up a pre-iteration callback to process outbound messages
    // and check the running flag
    uWS::Loop::get()->addPreHandler(this, [this](uWS::Loop*) {
        // Process outbound messages
        std::vector<Impl::OutboundMessage> outbound;
        {
            std::lock_guard<std::mutex> lock(impl->outboundMutex);
            outbound.swap(impl->outboundQueue);
        }

        for (auto& msg : outbound) {
            std::string_view sv(reinterpret_cast<const char*>(msg.data.data()), msg.data.size());

            if (msg.targetId == 0) {
                // Broadcast
                std::lock_guard<std::mutex> lock(impl->clientsMutex);
                for (auto& entry : impl->clients) {
                    entry.ws->send(sv, uWS::OpCode::BINARY, false);
                }
            } else {
                // Targeted send
                std::lock_guard<std::mutex> lock(impl->clientsMutex);
                for (auto& entry : impl->clients) {
                    if (entry.ws->getUserData()->id == msg.targetId) {
                        entry.ws->send(sv, uWS::OpCode::BINARY, false);
                        break;
                    }
                }
            }
        }

        // Check if we should shut down
        if (!running.load()) {
            // Close the listen socket so app.run() will eventually return
            if (impl->listenSocket) {
                us_listen_socket_close(0, impl->listenSocket);
                impl->listenSocket = nullptr;
            }
            // Close all client connections.
            // IMPORTANT: copy the socket list first, then close outside the
            // lock. ws->close() synchronously invokes the .close callback
            // which also takes clientsMutex — holding it here deadlocks
            // (std::mutex is non-recursive).
            std::vector<uWS::WebSocket<false, true, ClientData>*> toClose;
            {
                std::lock_guard<std::mutex> lock(impl->clientsMutex);
                toClose.reserve(impl->clients.size());
                for (auto& entry : impl->clients) toClose.push_back(entry.ws);
            }
            for (auto* ws : toClose) ws->close();
        }
    });

    app.run();

    impl->loop = nullptr;
    SLOG(SPRING_LOG_INFO, "network thread exiting");
}
