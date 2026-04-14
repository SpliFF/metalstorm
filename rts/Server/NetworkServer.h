/**
 * NetworkServer — HTTP server running on a dedicated thread.
 *
 * Serves HTTP GET/POST endpoints via uWebSockets. WebSocket transport
 * has been removed; real-time game traffic uses WebRTC instead.
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <thread>
#include <vector>

/// Identifies a connected client.
using ClientID = uint32_t;

/// An inbound message from a client (used by WebRTCServer).
struct InboundMessage {
    ClientID clientId;
    std::vector<uint8_t> data;
};

/// HTTP response data returned by an endpoint handler.
struct HttpResponse {
    std::string contentType = "application/octet-stream";
    std::vector<uint8_t> body;
    int status = 200;
    /// Cache-Control header value. Default "no-store" means dynamic data
    /// (not cached). Use "public, max-age=3600" for static assets.
    std::string cacheControl = "no-store";
};

/// Handler for an HTTP GET endpoint.
using HttpGetHandler = std::function<HttpResponse(const std::string& url)>;

/// HTTP request headers passed to POST handlers.
struct HttpRequestHeaders {
    std::string authorization;
    std::string contentType;
};

/// Handler for an HTTP POST endpoint. Receives URL, body, and headers.
using HttpPostHandler = std::function<HttpResponse(const std::string& url, const std::string& body,
                                                    const HttpRequestHeaders& headers)>;

class NetworkServer {
public:
    NetworkServer();
    ~NetworkServer();

    /// Start listening on the given port. Spawns the network thread.
    bool Start(int port);

    /// Stop the server and join the network thread.
    void Stop();

    /// Register an HTTP GET endpoint. Must be called before Start().
    void AddHttpGet(const std::string& pattern, HttpGetHandler handler);

    /// Register an HTTP POST endpoint. Must be called before Start().
    void AddHttpPost(const std::string& pattern, HttpPostHandler handler);

private:
    void NetworkThreadFunc(int port);

    // HTTP handlers registered before Start()
    std::vector<std::pair<std::string, HttpGetHandler>> httpGetHandlers;
    std::vector<std::pair<std::string, HttpPostHandler>> httpPostHandlers;

    std::thread networkThread;
    std::atomic<bool> running{false};

    // Opaque pointer to uWS event loop for shutdown coordination
    struct Impl;
    std::unique_ptr<Impl> impl;
};
