/**
 * NetworkServer — HTTP/2 + HTTP/1.1 server with SSE support.
 *
 * Built on nghttp2 for HTTP/2 (h2c cleartext) with automatic HTTP/1.1
 * fallback. Protocol is auto-detected from the connection preface.
 *
 * Browsers use HTTP/1.1 (h2 requires TLS; use a reverse proxy for that).
 * C++ clients (libspringapi) connect via h2c for multiplexed requests.
 *
 * SSE (Server-Sent Events) endpoints stream data to subscribers in
 * real-time. Works on both HTTP/1.1 and HTTP/2.
 *
 * WebTransport (QUIC) handles real-time game traffic (see
 * WebTransport/WebTransportServer).
 */
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

/// Identifies a connected client.
using ClientID = uint32_t;

/// An inbound message from a client (used by WebTransportServer).
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
    /// True when the TCP peer address is 127.0.0.0/8 or ::1 (including the
    /// IPv4-mapped ::ffff:127.x form a dual-stack accept() can produce).
    /// Used by endpoints that gate on "localhost origin" (e.g.
    /// /api/rooms/direct) — this is a peer-address check, not anything
    /// forgeable via a request header.
    bool remoteIsLoopback = false;
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

    /// Register an SSE (Server-Sent Events) endpoint pattern.
    /// Returns a channel ID for pushing events via SendSSE().
    /// Must be called before Start().
    uint32_t AddSSE(const std::string& pattern);

    /// Push an SSE event to all connected subscribers of a channel.
    /// Thread-safe: can be called from any thread.
    void SendSSE(uint32_t channelId, const std::string& data,
                 const std::string& event = "");

    /// Raw query string (everything after '?', undecoded) of the request
    /// currently being dispatched on this thread, or "" if none. Handlers
    /// receive only the decoded path as their `url` argument; call this to
    /// read query parameters. Valid only for the duration of the handler.
    static std::string CurrentQueryString();

private:
    void NetworkThreadFunc(int port);

    // HTTP handlers registered before Start()
    std::vector<std::pair<std::string, HttpGetHandler>> httpGetHandlers;
    std::vector<std::pair<std::string, HttpPostHandler>> httpPostHandlers;

    std::thread networkThread;
    std::atomic<bool> running{false};

    // Opaque implementation (nghttp2 sessions, connections, SSE state)
    struct Impl;
    std::unique_ptr<Impl> impl;
};
