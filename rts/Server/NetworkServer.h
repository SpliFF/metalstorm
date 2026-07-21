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

/// Required classification for every registered route (PLAN-security-hardening
/// G20 — "every new route defaults to open" because auth lived per-lambda with
/// no forcing function). `AddHttpGet`/`AddHttpPost` take this as a mandatory
/// argument so a route literally cannot be registered without a conscious
/// choice, and `GetRegisteredRoutes()` lets a CI/doctest snapshot test assert
/// the full set + classification hasn't drifted.
///
/// Enforcement note: POST handlers receive `HttpRequestHeaders` so
/// TokenRequired/AdminOnly/LocalhostOrAdmin are checked by NetworkServer
/// itself in DispatchPost *before* the handler runs (belt-and-braces on top
/// of whatever the handler does internally for its own business logic, e.g.
/// resolving which user is acting). GET handlers (`HttpGetHandler`) still never
/// receive headers/Authorization, so a non-Public GET route is enforced as
/// **loopback-only** in DispatchGet (PLAN-security-hardening G12): the token
/// half of TokenRequired/AdminOnly/LocalhostOrAdmin can't be checked without a
/// header, so the tag degrades to the strongest forgery-proof check available —
/// `remoteIsLoopback`. That is exactly what `/api/processes` (LocalhostOrAdmin)
/// needs. A GET route that requires real token/role auth must be converted to
/// POST (or `HttpGetHandler` extended to carry headers) — loopback-only is the
/// ceiling for GET today.
enum class RouteAuth {
    Public,           ///< No auth check.
    TokenRequired,     ///< Any valid session token (Bearer or Basic).
    AdminOnly,         ///< Valid token AND role=="admin".
    LocalhostOrAdmin,  ///< remoteIsLoopback OR (valid token AND role=="admin").
};

/// Callbacks a server wires in once at startup so NetworkServer can enforce
/// RouteAuth without depending on Database/HttpAuth directly (kept a
/// transport-only class; not every process that links it has a Database —
/// e.g. spring-logserver today only registers RouteAuth::Public routes and
/// never calls SetRouteAuthCallbacks).
struct RouteAuthCallbacks {
    /// Validate an Authorization header value, return the user ID or 0.
    std::function<int64_t(const std::string& authHeader)> validateToken;
    /// Return true if the given (already-validated) user ID has the admin role.
    std::function<bool(int64_t userId)> isAdmin;
};

/// One registered route's classification, for route-table snapshot tests.
struct RouteInfo {
    std::string method;  // "GET" or "POST"
    std::string pattern;
    RouteAuth auth;
};

class NetworkServer {
public:
    NetworkServer();
    ~NetworkServer();

    /// Start listening on the given port. Spawns the network thread.
    bool Start(int port);

    /// Stop the server and join the network thread.
    void Stop();

    /// Register an HTTP GET endpoint. Must be called before Start().
    void AddHttpGet(const std::string& pattern, RouteAuth auth, HttpGetHandler handler);

    /// Register an HTTP POST endpoint. Must be called before Start().
    void AddHttpPost(const std::string& pattern, RouteAuth auth, HttpPostHandler handler);

    /// Register an SSE (Server-Sent Events) endpoint pattern.
    /// Returns a channel ID for pushing events via SendSSE().
    /// Must be called before Start().
    uint32_t AddSSE(const std::string& pattern);

    /// Push an SSE event to all connected subscribers of a channel.
    /// Thread-safe: can be called from any thread.
    void SendSSE(uint32_t channelId, const std::string& data,
                 const std::string& event = "");

    /// Wire the callbacks DispatchPost uses to enforce TokenRequired/AdminOnly/
    /// LocalhostOrAdmin. Must be called before Start() if any registered POST
    /// route uses a non-Public RouteAuth. Processes with no Database (e.g.
    /// spring-logserver today) can skip this as long as every route they
    /// register is RouteAuth::Public.
    void SetRouteAuthCallbacks(RouteAuthCallbacks callbacks);

    /// Snapshot of every registered GET/POST route and its RouteAuth
    /// classification. Feeds the route-table snapshot test (PLAN-security-
    /// hardening task 6 / gap G20). Does not include SSE channels.
    std::vector<RouteInfo> GetRegisteredRoutes() const;

    /// Raw query string (everything after '?', undecoded) of the request
    /// currently being dispatched on this thread, or "" if none. Handlers
    /// receive only the decoded path as their `url` argument; call this to
    /// read query parameters. Valid only for the duration of the handler.
    static std::string CurrentQueryString();

    /// Test hook: invokes `fn` through the exact exception-safety wrapper
    /// DispatchGet/DispatchPost/CheckAuthAndCall use for every route handler
    /// — any exception `fn` throws becomes a 500 HttpResponse instead of
    /// propagating. Lets a unit test prove a handler that throws can't take
    /// down the process without standing up a live socket. Not used by
    /// production dispatch directly (that calls the same underlying helper
    /// with the real route handler); exposed here purely for testing, same
    /// as GetRegisteredRoutes().
    static HttpResponse SafeInvokeForTest(const std::string& path,
                                           const std::function<HttpResponse()>& fn);

private:
    void NetworkThreadFunc(int port);

    struct GetRoute { std::string pattern; RouteAuth auth; HttpGetHandler handler; };
    struct PostRoute { std::string pattern; RouteAuth auth; HttpPostHandler handler; };

    // HTTP handlers registered before Start()
    std::vector<GetRoute> httpGetHandlers;
    std::vector<PostRoute> httpPostHandlers;
    RouteAuthCallbacks routeAuthCallbacks;

    std::thread networkThread;
    std::atomic<bool> running{false};

    // Opaque implementation (nghttp2 sessions, connections, SSE state)
    struct Impl;
    std::unique_ptr<Impl> impl;
};
