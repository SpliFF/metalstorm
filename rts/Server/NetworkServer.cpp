/**
 * NetworkServer — HTTP-only server built on uWebSockets.
 *
 * Runs uWS::App on a dedicated thread. Serves HTTP GET/POST endpoints.
 * WebSocket transport has been removed; real-time game traffic uses
 * WebRTC (see WebRTCServer).
 */

#include "NetworkServer.h"
#include "CacheControl.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "net"

// uWebSockets includes
#include <App.h>

#include <cstdio>
#include <memory>
#include <string>
#include <string_view>

/// Internal state that depends on uWS types (kept out of the header).
struct NetworkServer::Impl {
    // The uWS event loop, used for cross-thread defer()
    struct us_loop_t* loop = nullptr;

    // Listen socket — closed to trigger app.run() exit
    us_listen_socket_t* listenSocket = nullptr;
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
            // The preHandler will close the listen socket and let app.run() exit
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

    // Set up a pre-iteration callback to check the running flag
    uWS::Loop::get()->addPreHandler(this, [this](uWS::Loop*) {
        if (!running.load()) {
            // Close the listen socket so app.run() will eventually return
            if (impl->listenSocket) {
                us_listen_socket_close(0, impl->listenSocket);
                impl->listenSocket = nullptr;
            }
        }
    });

    app.run();

    impl->loop = nullptr;
    SLOG(SPRING_LOG_INFO, "network thread exiting");
}
