/**
 * NetworkServer — HTTP/2 + HTTP/1.1 server built on nghttp2.
 *
 * Auto-detects h2c (cleartext HTTP/2) vs HTTP/1.1 from the connection
 * preface. Dispatches to the same handler interface either way.
 *
 * Uses poll() for I/O multiplexing on a dedicated thread. Supports
 * Server-Sent Events (SSE) for streaming endpoints.
 */

#include "NetworkServer.h"
#include "CacheControl.h"
#include "System/SpringLog/SpringLog.h"

#include <nghttp2/nghttp2.h>

#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <poll.h>

#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstring>
#include <exception>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#define LOG_SECTION "net"

// ═══════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════

namespace {

/// Raw query string of the request being dispatched on this thread. Set by
/// DispatchGet/DispatchPost before each handler runs (handlers run
/// synchronously on the network thread, so one request is in flight per
/// thread at a time). Read via NetworkServer::CurrentQueryString().
thread_local std::string tl_queryString;
void SetCurrentQueryString(const std::string& qs) { tl_queryString = qs; }

/// HTTP/2 connection preface (24 bytes).
static const char H2_PREFACE[] = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
static constexpr size_t H2_PREFACE_LEN = 24;

const char* StatusText(int code) {
    switch (code) {
        case 200: return "200 OK";
        case 201: return "201 Created";
        case 204: return "204 No Content";
        case 400: return "400 Bad Request";
        case 401: return "401 Unauthorized";
        case 403: return "403 Forbidden";
        case 404: return "404 Not Found";
        case 405: return "405 Method Not Allowed";
        case 409: return "409 Conflict";
        case 500: return "500 Internal Server Error";
        default:  return "500 Internal Server Error";
    }
}

/// Match a URL against a route pattern.
/// Supports exact match and /* wildcard suffix.
bool RouteMatch(const std::string& pattern, const std::string& url) {
    // Strip query string from url for matching
    auto qpos = url.find('?');
    std::string path = (qpos != std::string::npos) ? url.substr(0, qpos) : url;

    if (pattern.size() >= 2 && pattern.substr(pattern.size() - 2) == "/*") {
        std::string prefix = pattern.substr(0, pattern.size() - 2);
        return path.rfind(prefix, 0) == 0 && (path.size() == prefix.size() || path[prefix.size()] == '/');
    }
    // Match with or without trailing slash
    if (pattern.back() != '/' && path == pattern + "/") return true;
    return path == pattern;
}

void SetNonBlocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

void SetTcpNoDelay(int fd) {
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
}

HttpResponse JsonError(int status, const char* msg) {
    std::string json = std::string("{\"error\":\"") + msg + "\"}";
    return {.contentType = "application/json", .body = {json.begin(), json.end()}, .status = status};
}

/// Route handlers parse client-supplied JSON with nlohmann and reach into it
/// with `.value()`/`.get<T>()` — a body that's well-formed JSON but has the
/// wrong shape (e.g. a string field sent as an object) throws
/// nlohmann::json::type_error, which is a std::exception. Handlers don't
/// guard every field access, so this is the last line of defence: an
/// uncaught exception used to propagate out of DispatchGet/DispatchPost and
/// take down the whole lobby process (see the room-abandon
/// json.exception.type_error.302 crash). One bad request should return 500,
/// not kill every other player's connection. Shared by DispatchGet,
/// CheckAuthAndCall, and NetworkServer::SafeInvokeForTest so the unit test
/// exercises the exact same code path production traffic runs through.
HttpResponse SafeInvoke(const std::string& path, const std::function<HttpResponse()>& fn) {
    try {
        return fn();
    } catch (const std::exception& e) {
        SLOG(SPRING_LOG_ERROR, "handler for '%s' threw: %s", path.c_str(), e.what());
        return JsonError(500, "internal error");
    } catch (...) {
        SLOG(SPRING_LOG_ERROR, "handler for '%s' threw a non-standard exception", path.c_str());
        return JsonError(500, "internal error");
    }
}

/// True if `addr` is a loopback peer — plain IPv6 ::1, or an IPv4-mapped
/// ::ffff:127.x.x.x address (produced when a dual-stack listener accepts
/// an IPv4 connection into a sockaddr_in6).
bool IsLoopbackAddr(const sockaddr_in6& addr) {
    if (IN6_IS_ADDR_LOOPBACK(&addr.sin6_addr)) return true;
    if (IN6_IS_ADDR_V4MAPPED(&addr.sin6_addr))
        return addr.sin6_addr.s6_addr[12] == 127;
    return false;
}

/// Percent-decode a URL path. Decodes `%XX` triplets and `+` is left as-is
/// (we only decode paths, not form-encoded query bodies). Malformed escapes
/// are passed through verbatim. The `..` traversal check still runs after
/// decoding so `%2E%2E` cannot bypass it.
std::string UrlDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            int hi = hex(s[i + 1]);
            int lo = hex(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back(static_cast<char>((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back(s[i]);
    }
    return out;
}

/// Extract query parameter value from a URL.
std::string QueryParam(const std::string& url, const std::string& key) {
    auto qpos = url.find('?');
    if (qpos == std::string::npos) return "";
    std::string qs = url.substr(qpos + 1);
    std::string needle = key + "=";
    auto pos = qs.find(needle);
    // Make sure it's at start or after &
    while (pos != std::string::npos) {
        if (pos == 0 || qs[pos - 1] == '&') {
            auto valStart = pos + needle.size();
            auto valEnd = qs.find('&', valStart);
            return qs.substr(valStart, valEnd == std::string::npos ? valEnd : valEnd - valStart);
        }
        pos = qs.find(needle, pos + 1);
    }
    return "";
}

} // namespace

// ═══════════════════════════════════════════════════════════════════════
// Per-connection state
// ═══════════════════════════════════════════════════════════════════════

/// Per HTTP/2 stream data (one stream = one request/response).
struct H2StreamData {
    int32_t streamId = 0;
    std::string method;
    std::string path;
    HttpRequestHeaders headers;
    std::string body;
    bool headersComplete = false;

    // Response (set by handler, consumed by data provider)
    std::vector<uint8_t> responseBody;
    size_t responseOffset = 0;
    bool responseReady = false;

    // SSE stream (kept open, not EOF)
    bool isSSE = false;
    uint32_t sseChannelId = UINT32_MAX;
    std::vector<std::string> sseQueue;
};

// Resource limits (S5). The HTTP plane serves the API + static assets; no
// endpoint legitimately needs a multi-megabyte request body, and an unbounded
// accept loop or read buffer is a trivial memory-exhaustion DoS.
//   MAX_REQUEST_BODY — cap on a single request's buffered bytes (headers +
//   body). Oversize requests get 413 and the connection is closed.
//   MAX_CONNECTIONS  — cap on simultaneously-open TCP connections; excess
//   accepts are closed immediately.
static constexpr size_t MAX_REQUEST_BODY = 8 * 1024 * 1024;  // 8 MB
static constexpr size_t MAX_CONNECTIONS  = 1024;

struct ServerConn {
    int fd = -1;
    void* server = nullptr;  // back-pointer to NetworkServer::Impl (private type)
    bool remoteIsLoopback = false;  // set once from the accept()'d peer address

    enum Protocol { DETECTING, HTTP1, HTTP2 } protocol = DETECTING;

    // Detection buffer (first bytes determine protocol)
    std::vector<uint8_t> detectBuf;

    // ── HTTP/1.1 state ──
    std::string h1ReadBuf;
    bool h1HeadersDone = false;
    int h1ContentLength = 0;
    std::string h1Method;
    std::string h1Path;
    HttpRequestHeaders h1Headers;
    // SSE over HTTP/1.1
    bool h1IsSSE = false;
    uint32_t h1SSEChannelId = UINT32_MAX;

    // ── HTTP/2 state ──
    nghttp2_session* h2session = nullptr;
    std::map<int32_t, H2StreamData> h2streams;

    // ── Shared write buffer ──
    std::string writeBuf;

    ~ServerConn() {
        if (h2session) nghttp2_session_del(h2session);
        if (fd >= 0) ::close(fd);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// Impl
// ═══════════════════════════════════════════════════════════════════════

struct NetworkServer::Impl {
    int listenFd = -1;
    int wakePipe[2] = {-1, -1};  // pipe for cross-thread wakeup
    std::map<int, std::unique_ptr<ServerConn>> connections;
    std::vector<int> pendingClose;

    // Handler references (set before Start)
    const std::vector<NetworkServer::GetRoute>* getHandlers = nullptr;
    const std::vector<NetworkServer::PostRoute>* postHandlers = nullptr;
    const RouteAuthCallbacks* authCallbacks = nullptr;

    // SSE channels
    struct SSEChannel { std::string pattern; };
    std::vector<SSEChannel> sseChannels;

    // Thread-safe SSE event queue
    std::mutex sseMutex;
    struct SSEEvent { uint32_t channelId; std::string data; std::string event; };
    std::vector<SSEEvent> sseQueue;

    // ── Route dispatch ──
    // JsonError/SafeInvoke live in the anonymous namespace above so
    // NetworkServer::SafeInvokeForTest can exercise the identical exception-
    // handling path without a live socket.

    HttpResponse DispatchGet(const std::string& url) {
        // Strip query string and percent-decode — handlers receive the
        // clean, decoded path only. The raw query string is stashed on a
        // thread-local so handlers can read params via
        // NetworkServer::CurrentQueryString() without it corrupting
        // path-segment extraction in wildcard routes.
        auto qpos = url.find('?');
        const std::string rawPath = (qpos != std::string::npos) ? url.substr(0, qpos) : url;
        const std::string path = UrlDecode(rawPath);
        SetCurrentQueryString(qpos != std::string::npos ? url.substr(qpos + 1) : "");
        // Try exact matches first, then wildcards. RouteAuth is not enforced
        // here — see the RouteAuth comment in NetworkServer.h (GET handlers
        // never receive headers/Authorization; no currently-open GET route
        // needs auth, so the tag is classification-only for GET today).
        for (auto& route : *getHandlers) {
            if (route.pattern.find('*') == std::string::npos && RouteMatch(route.pattern, path))
                return SafeInvoke(path, [&] { return route.handler(path); });
        }
        for (auto& route : *getHandlers) {
            if (route.pattern.find('*') != std::string::npos && RouteMatch(route.pattern, path))
                return SafeInvoke(path, [&] { return route.handler(path); });
        }
        return {.contentType = "text/plain", .body = {'4','0','4'}, .status = 404};
    }

    /// Default-deny check for POST routes (PLAN-security-hardening G20). Runs
    /// before the handler for any non-Public RouteAuth. Belt-and-braces: the
    /// handler is free to do its own auth lookups on top of this for business
    /// logic (e.g. which user is acting), this is just the gate.
    ///
    /// The gate itself runs INSIDE SafeInvoke, not just the handler: the auth
    /// callbacks (validateToken/isAdmin) are SQLite-backed and can throw
    /// exactly like a handler can — invoking them outside the wrapper meant a
    /// throwing callback still crashed dispatch, the class of failure
    /// SafeInvoke exists to eliminate.
    HttpResponse CheckAuthAndCall(const NetworkServer::PostRoute& route, const std::string& path,
                                   const std::string& body, const HttpRequestHeaders& hdrs) {
        return SafeInvoke(path, [&]() -> HttpResponse {
            if (route.auth != RouteAuth::Public) {
                int64_t userId = 0;
                if (authCallbacks && authCallbacks->validateToken)
                    userId = authCallbacks->validateToken(hdrs.authorization);
                const bool tokenOk = userId > 0;
                const bool adminOk = tokenOk && authCallbacks && authCallbacks->isAdmin && authCallbacks->isAdmin(userId);
                switch (route.auth) {
                    case RouteAuth::TokenRequired:
                        if (!tokenOk) return JsonError(401, "unauthorized");
                        break;
                    case RouteAuth::AdminOnly:
                        if (!adminOk) return JsonError(tokenOk ? 403 : 401, tokenOk ? "forbidden — admin role required" : "unauthorized");
                        break;
                    case RouteAuth::LocalhostOrAdmin:
                        if (!hdrs.remoteIsLoopback && !adminOk) return JsonError(tokenOk ? 403 : 401, tokenOk ? "forbidden" : "unauthorized");
                        break;
                    default: break;
                }
            }
            return route.handler(path, body, hdrs);
        });
    }

    HttpResponse DispatchPost(const std::string& url, const std::string& body,
                              const HttpRequestHeaders& hdrs) {
        auto qpos = url.find('?');
        const std::string rawPath = (qpos != std::string::npos) ? url.substr(0, qpos) : url;
        const std::string path = UrlDecode(rawPath);
        SetCurrentQueryString(qpos != std::string::npos ? url.substr(qpos + 1) : "");
        for (auto& route : *postHandlers) {
            if (route.pattern.find('*') == std::string::npos && RouteMatch(route.pattern, path))
                return CheckAuthAndCall(route, path, body, hdrs);
        }
        for (auto& route : *postHandlers) {
            if (route.pattern.find('*') != std::string::npos && RouteMatch(route.pattern, path))
                return CheckAuthAndCall(route, path, body, hdrs);
        }
        return {.contentType = "text/plain", .body = {'4','0','4'}, .status = 404};
    }

    int MatchSSEChannel(const std::string& url) {
        for (size_t i = 0; i < sseChannels.size(); i++) {
            if (RouteMatch(sseChannels[i].pattern, url)) return (int)i;
        }
        return -1;
    }

    // ── HTTP/1.1 helpers ──

    void H1WriteResponse(ServerConn& c, const HttpResponse& resp, bool omitBody = false) {
        std::string hdr;
        hdr += "HTTP/1.1 ";
        hdr += StatusText(resp.status);
        hdr += "\r\nContent-Type: ";
        hdr += resp.contentType;
        hdr += "\r\nContent-Length: ";
        hdr += std::to_string(resp.body.size());
        hdr += "\r\nAccess-Control-Allow-Origin: *";
        hdr += "\r\nAccess-Control-Allow-Methods: GET, HEAD, POST, OPTIONS";
        hdr += "\r\nAccess-Control-Allow-Headers: Content-Type, Authorization";
        hdr += "\r\nCache-Control: ";
        hdr += resp.cacheControl;
        hdr += "\r\nX-Build-Stamp: ";
        hdr += CacheControl::BuildStamp();
        hdr += "\r\nConnection: keep-alive";
        hdr += "\r\n\r\n";

        c.writeBuf += hdr;
        // HEAD responses carry the same Content-Length the GET would, but
        // RFC 9110 §9.3.2 requires the body itself to be omitted.
        if (!omitBody)
            c.writeBuf.append(reinterpret_cast<const char*>(resp.body.data()), resp.body.size());
    }

    void H1WriteCORSPreflight(ServerConn& c) {
        std::string hdr = "HTTP/1.1 204 No Content\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type, Authorization\r\n"
            "Content-Length: 0\r\n"
            "Connection: keep-alive\r\n\r\n";
        c.writeBuf += hdr;
    }

    void H1WriteSSEHeaders(ServerConn& c) {
        std::string hdr = "HTTP/1.1 200 OK\r\n"
            "Content-Type: text/event-stream\r\n"
            "Cache-Control: no-cache\r\n"
            "Connection: keep-alive\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "X-Accel-Buffering: no\r\n"
            "\r\n";
        c.writeBuf += hdr;
    }

    void H1WriteSSEEvent(ServerConn& c, const std::string& data, const std::string& event) {
        if (!event.empty()) {
            c.writeBuf += "event: ";
            c.writeBuf += event;
            c.writeBuf += "\n";
        }
        c.writeBuf += "data: ";
        c.writeBuf += data;
        c.writeBuf += "\n\n";
    }

    // Process a complete HTTP/1.1 request
    void H1ProcessRequest(ServerConn& c) {
        // CORS preflight
        if (c.h1Method == "OPTIONS") {
            H1WriteCORSPreflight(c);
        } else if (c.h1Method == "GET" || c.h1Method == "HEAD") {
            // Check SSE first (HEAD on an SSE endpoint is meaningless;
            // fall through to a regular GET dispatch + body suppression).
            const bool isHead = (c.h1Method == "HEAD");
            if (!isHead) {
                int sseId = MatchSSEChannel(c.h1Path);
                if (sseId >= 0) {
                    c.h1IsSSE = true;
                    c.h1SSEChannelId = (uint32_t)sseId;
                    H1WriteSSEHeaders(c);
                    return;  // Don't reset — keep connection open for SSE
                }
            }
            auto resp = DispatchGet(c.h1Path);
            H1WriteResponse(c, resp, /*omitBody=*/isHead);
        } else if (c.h1Method == "POST") {
            auto resp = DispatchPost(c.h1Path, c.h1ReadBuf.substr(
                c.h1ReadBuf.find("\r\n\r\n") + 4, c.h1ContentLength), c.h1Headers);
            H1WriteResponse(c, resp);
        } else {
            HttpResponse resp = {.contentType = "text/plain",
                                 .body = {'4','0','5'}, .status = 405};
            H1WriteResponse(c, resp);
        }

        // Reset for next request on this connection (keep-alive)
        c.h1ReadBuf.clear();
        c.h1HeadersDone = false;
        c.h1ContentLength = 0;
        c.h1Method.clear();
        c.h1Path.clear();
        c.h1Headers = {};
    }

    // Parse incoming HTTP/1.1 data
    void H1HandleData(ServerConn& c, const char* data, size_t len) {
        c.h1ReadBuf.append(data, len);

        // Already an SSE connection — ignore further client data
        if (c.h1IsSSE) return;

        // S5: cap buffered request size. Covers both an oversize body and a
        // header flood / bodyless stream that never completes (the parse loop
        // would otherwise keep returning "need more data" while the buffer
        // grows without bound).
        if (c.h1ReadBuf.size() > MAX_REQUEST_BODY) {
            HttpResponse resp = {.contentType = "text/plain",
                                 .body = {'4','1','3'}, .status = 413};
            H1WriteResponse(c, resp);
            pendingClose.push_back(c.fd);
            return;
        }

        while (true) {
            if (!c.h1HeadersDone) {
                auto hdrEnd = c.h1ReadBuf.find("\r\n\r\n");
                if (hdrEnd == std::string::npos) return;  // Need more data

                // Parse request line
                auto lineEnd = c.h1ReadBuf.find("\r\n");
                std::string requestLine = c.h1ReadBuf.substr(0, lineEnd);
                auto sp1 = requestLine.find(' ');
                auto sp2 = requestLine.find(' ', sp1 + 1);
                c.h1Method = requestLine.substr(0, sp1);
                c.h1Path = (sp2 != std::string::npos)
                    ? requestLine.substr(sp1 + 1, sp2 - sp1 - 1)
                    : requestLine.substr(sp1 + 1);

                // Parse headers
                size_t pos = lineEnd + 2;
                while (pos < hdrEnd) {
                    auto next = c.h1ReadBuf.find("\r\n", pos);
                    if (next == std::string::npos || next > hdrEnd) break;
                    std::string line = c.h1ReadBuf.substr(pos, next - pos);
                    auto colon = line.find(':');
                    if (colon != std::string::npos) {
                        std::string key = line.substr(0, colon);
                        std::string val = line.substr(colon + 1);
                        // Trim leading whitespace from value
                        while (!val.empty() && val[0] == ' ') val.erase(0, 1);
                        // Case-insensitive header matching
                        std::string lower;
                        lower.resize(key.size());
                        std::transform(key.begin(), key.end(), lower.begin(), ::tolower);
                        if (lower == "authorization") c.h1Headers.authorization = val;
                        else if (lower == "content-type") c.h1Headers.contentType = val;
                        else if (lower == "content-length") c.h1ContentLength = std::atoi(val.c_str());
                    }
                    pos = next + 2;
                }
                c.h1Headers.remoteIsLoopback = c.remoteIsLoopback;
                c.h1HeadersDone = true;

                // S5: reject an oversize declared body up front rather than
                // buffering toward the cap.
                if (c.h1ContentLength > 0 &&
                    static_cast<size_t>(c.h1ContentLength) > MAX_REQUEST_BODY) {
                    HttpResponse resp = {.contentType = "text/plain",
                                         .body = {'4','1','3'}, .status = 413};
                    H1WriteResponse(c, resp);
                    pendingClose.push_back(c.fd);
                    return;
                }
            }

            // Check if we have the full body
            auto bodyStart = c.h1ReadBuf.find("\r\n\r\n");
            if (bodyStart == std::string::npos) return;
            bodyStart += 4;

            if (c.h1ContentLength > 0) {
                size_t bodyAvail = c.h1ReadBuf.size() - bodyStart;
                if ((int)bodyAvail < c.h1ContentLength) return;  // Need more body
            }

            H1ProcessRequest(c);

            // If SSE, stop processing further requests
            if (c.h1IsSSE) return;

            // Check if there's another pipelined request
            if (c.h1ReadBuf.empty()) return;
        }
    }

    // ── HTTP/2 nghttp2 callbacks ──

    static int OnBeginHeaders(nghttp2_session* session,
                               const nghttp2_frame* frame, void* user_data) {
        if (frame->hd.type != NGHTTP2_HEADERS || frame->headers.cat != NGHTTP2_HCAT_REQUEST)
            return 0;
        auto* conn = static_cast<ServerConn*>(user_data);
        H2StreamData stream{.streamId = frame->hd.stream_id};
        stream.headers.remoteIsLoopback = conn->remoteIsLoopback;
        conn->h2streams[frame->hd.stream_id] = std::move(stream);
        return 0;
    }

    static int OnHeader(nghttp2_session* session, const nghttp2_frame* frame,
                        const uint8_t* name, size_t namelen,
                        const uint8_t* value, size_t valuelen,
                        uint8_t flags, void* user_data) {
        if (frame->hd.type != NGHTTP2_HEADERS) return 0;
        auto* conn = static_cast<ServerConn*>(user_data);
        auto it = conn->h2streams.find(frame->hd.stream_id);
        if (it == conn->h2streams.end()) return 0;

        std::string n(reinterpret_cast<const char*>(name), namelen);
        std::string v(reinterpret_cast<const char*>(value), valuelen);

        if (n == ":method") it->second.method = v;
        else if (n == ":path") it->second.path = v;
        else if (n == "authorization") it->second.headers.authorization = v;
        else if (n == "content-type") it->second.headers.contentType = v;
        return 0;
    }

    static int OnDataChunkRecv(nghttp2_session* session, uint8_t flags,
                                int32_t stream_id, const uint8_t* data,
                                size_t len, void* user_data) {
        auto* conn = static_cast<ServerConn*>(user_data);
        auto it = conn->h2streams.find(stream_id);
        if (it != conn->h2streams.end()) {
            // S5: cap the buffered request body; reset the stream if a client
            // streams more than the limit (HTTP/2 has no Content-Length gate).
            if (it->second.body.size() + len > MAX_REQUEST_BODY) {
                nghttp2_submit_rst_stream(session, NGHTTP2_FLAG_NONE, stream_id,
                                          NGHTTP2_ENHANCE_YOUR_CALM);
                return 0;
            }
            it->second.body.append(reinterpret_cast<const char*>(data), len);
        }
        return 0;
    }

    static ssize_t ResponseDataRead(nghttp2_session* session, int32_t stream_id,
                                     uint8_t* buf, size_t length,
                                     uint32_t* data_flags,
                                     nghttp2_data_source* source,
                                     void* user_data) {
        auto* stream = static_cast<H2StreamData*>(source->ptr);

        // SSE stream: check queue
        if (stream->isSSE) {
            if (stream->sseQueue.empty()) {
                return NGHTTP2_ERR_DEFERRED;
            }
            std::string& front = stream->sseQueue.front();
            size_t n = std::min(front.size(), length);
            memcpy(buf, front.data(), n);
            if (n >= front.size()) {
                stream->sseQueue.erase(stream->sseQueue.begin());
            } else {
                front.erase(0, n);
            }
            return (ssize_t)n;
        }

        // Normal response
        size_t remaining = stream->responseBody.size() - stream->responseOffset;
        if (remaining == 0) {
            *data_flags |= NGHTTP2_DATA_FLAG_EOF;
            return 0;
        }
        size_t n = std::min(remaining, length);
        memcpy(buf, stream->responseBody.data() + stream->responseOffset, n);
        stream->responseOffset += n;
        if (stream->responseOffset >= stream->responseBody.size()) {
            *data_flags |= NGHTTP2_DATA_FLAG_EOF;
        }
        return (ssize_t)n;
    }

    static int OnFrameRecv(nghttp2_session* session,
                            const nghttp2_frame* frame, void* user_data) {
        auto* conn = static_cast<ServerConn*>(user_data);
        auto* impl = static_cast<Impl*>(conn->server);

        // Only process when END_STREAM is set (request complete)
        if (frame->hd.type == NGHTTP2_HEADERS && (frame->hd.flags & NGHTTP2_FLAG_END_STREAM)) {
            impl->H2ProcessRequest(*conn, frame->hd.stream_id);
        }
        if (frame->hd.type == NGHTTP2_DATA && (frame->hd.flags & NGHTTP2_FLAG_END_STREAM)) {
            impl->H2ProcessRequest(*conn, frame->hd.stream_id);
        }
        return 0;
    }

    // Process a complete HTTP/2 request
    void H2ProcessRequest(ServerConn& conn, int32_t streamId) {
        auto it = conn.h2streams.find(streamId);
        if (it == conn.h2streams.end()) return;
        auto& stream = it->second;
        if (stream.responseReady) return;  // Already handled
        stream.responseReady = true;

        // CORS preflight
        if (stream.method == "OPTIONS") {
            H2SubmitResponse(conn, stream, {.status = 204});
            return;
        }

        if (stream.method == "GET" || stream.method == "HEAD") {
            const bool isHead = (stream.method == "HEAD");
            if (!isHead) {
                int sseId = MatchSSEChannel(stream.path);
                if (sseId >= 0) {
                    stream.isSSE = true;
                    stream.sseChannelId = (uint32_t)sseId;
                    H2SubmitSSEHeaders(conn, stream);
                    return;
                }
            }
            auto resp = DispatchGet(stream.path);
            H2SubmitResponse(conn, stream, resp, /*omitBody=*/isHead);
        } else if (stream.method == "POST") {
            auto resp = DispatchPost(stream.path, stream.body, stream.headers);
            H2SubmitResponse(conn, stream, resp);
        } else {
            H2SubmitResponse(conn, stream, {.status = 405});
        }
    }

    void H2SubmitResponse(ServerConn& conn, H2StreamData& stream, const HttpResponse& resp, bool omitBody = false) {
        // HEAD responses carry Content-Length but no body — clear the
        // streamed payload while leaving the headers (including the
        // original body size) intact.
        stream.responseBody = omitBody ? std::vector<uint8_t>{} : resp.body;
        stream.responseOffset = 0;

        std::string statusStr = std::to_string(resp.status);
        std::string buildStamp = CacheControl::BuildStamp();

        nghttp2_nv hdrs[] = {
            {(uint8_t*)":status", (uint8_t*)statusStr.data(), 7, statusStr.size(), NGHTTP2_NV_FLAG_NO_COPY_NAME},
            {(uint8_t*)"content-type", (uint8_t*)resp.contentType.data(), 12, resp.contentType.size(), NGHTTP2_NV_FLAG_NO_COPY_NAME},
            {(uint8_t*)"access-control-allow-origin", (uint8_t*)"*", 27, 1, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"access-control-allow-methods", (uint8_t*)"GET, HEAD, POST, OPTIONS", 28, 24, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"access-control-allow-headers", (uint8_t*)"Content-Type, Authorization", 28, 27, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"cache-control", (uint8_t*)resp.cacheControl.data(), 13, resp.cacheControl.size(), NGHTTP2_NV_FLAG_NO_COPY_NAME},
            {(uint8_t*)"x-build-stamp", (uint8_t*)buildStamp.data(), 13, buildStamp.size(), NGHTTP2_NV_FLAG_NO_COPY_NAME},
        };

        nghttp2_data_provider prd;
        prd.source.ptr = &stream;
        prd.read_callback = ResponseDataRead;

        nghttp2_submit_response(conn.h2session, stream.streamId,
                                 hdrs, sizeof(hdrs)/sizeof(hdrs[0]),
                                 resp.body.empty() ? nullptr : &prd);
    }

    void H2SubmitSSEHeaders(ServerConn& conn, H2StreamData& stream) {
        nghttp2_nv hdrs[] = {
            {(uint8_t*)":status", (uint8_t*)"200", 7, 3, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"content-type", (uint8_t*)"text/event-stream", 12, 17, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"cache-control", (uint8_t*)"no-cache", 13, 8, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
            {(uint8_t*)"access-control-allow-origin", (uint8_t*)"*", 27, 1, NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE},
        };

        nghttp2_data_provider prd;
        prd.source.ptr = &stream;
        prd.read_callback = ResponseDataRead;

        nghttp2_submit_response(conn.h2session, stream.streamId,
                                 hdrs, sizeof(hdrs)/sizeof(hdrs[0]), &prd);
    }

    // Flush nghttp2 session output to connection write buffer
    void H2FlushSession(ServerConn& conn) {
        if (!conn.h2session) return;
        while (true) {
            const uint8_t* data;
            ssize_t len = nghttp2_session_mem_send(conn.h2session, &data);
            if (len < 0) {
                SLOG(SPRING_LOG_ERROR, "nghttp2_session_mem_send error: %s",
                     nghttp2_strerror((int)len));
                break;
            }
            if (len == 0) break;
            conn.writeBuf.append(reinterpret_cast<const char*>(data), len);
        }
    }

    // Initialize an HTTP/2 session for a connection
    void H2InitSession(ServerConn& conn) {
        nghttp2_session_callbacks* cbs;
        nghttp2_session_callbacks_new(&cbs);
        nghttp2_session_callbacks_set_on_begin_headers_callback(cbs, OnBeginHeaders);
        nghttp2_session_callbacks_set_on_header_callback(cbs, OnHeader);
        nghttp2_session_callbacks_set_on_frame_recv_callback(cbs, OnFrameRecv);
        nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cbs, OnDataChunkRecv);

        nghttp2_session_server_new(&conn.h2session, cbs, &conn);
        nghttp2_session_callbacks_del(cbs);

        // Send server connection preface (SETTINGS frame)
        nghttp2_settings_entry settings[] = {
            {NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 100},
        };
        nghttp2_submit_settings(conn.h2session, NGHTTP2_FLAG_NONE,
                                 settings, sizeof(settings)/sizeof(settings[0]));
        H2FlushSession(conn);
    }

    // ── Connection lifecycle ──

    void AcceptConnections() {
        while (true) {
            struct sockaddr_in6 addr;
            socklen_t addrlen = sizeof(addr);
            int fd = accept(listenFd, (struct sockaddr*)&addr, &addrlen);
            if (fd < 0) break;

            // S5: cap concurrent connections. Drop the excess immediately
            // rather than letting an attacker exhaust fds / memory.
            if (connections.size() >= MAX_CONNECTIONS) {
                ::close(fd);
                continue;
            }

            SetNonBlocking(fd);
            SetTcpNoDelay(fd);

            auto conn = std::make_unique<ServerConn>();
            conn->fd = fd;
            conn->server = this;
            conn->remoteIsLoopback = IsLoopbackAddr(addr);
            connections[fd] = std::move(conn);
        }
    }

    void HandleRead(ServerConn& conn) {
        char buf[65536];
        while (true) {
            ssize_t n = recv(conn.fd, buf, sizeof(buf), 0);
            if (n < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                pendingClose.push_back(conn.fd);
                return;
            }
            if (n == 0) {
                pendingClose.push_back(conn.fd);
                return;
            }

            if (conn.protocol == ServerConn::DETECTING) {
                conn.detectBuf.insert(conn.detectBuf.end(), buf, buf + n);
                if (conn.detectBuf.size() >= H2_PREFACE_LEN) {
                    if (memcmp(conn.detectBuf.data(), H2_PREFACE, H2_PREFACE_LEN) == 0) {
                        conn.protocol = ServerConn::HTTP2;
                        H2InitSession(conn);
                        // Feed all buffered data (including preface) to nghttp2
                        ssize_t consumed = nghttp2_session_mem_recv(
                            conn.h2session, conn.detectBuf.data(), conn.detectBuf.size());
                        if (consumed < 0) {
                            SLOG(SPRING_LOG_ERROR, "h2 initial recv error: %s",
                                 nghttp2_strerror((int)consumed));
                            pendingClose.push_back(conn.fd);
                            return;
                        }
                        H2FlushSession(conn);
                    } else {
                        conn.protocol = ServerConn::HTTP1;
                        // Feed buffered data to HTTP/1.1 parser
                        H1HandleData(conn, reinterpret_cast<const char*>(conn.detectBuf.data()),
                                     conn.detectBuf.size());
                    }
                    conn.detectBuf.clear();
                    conn.detectBuf.shrink_to_fit();
                } else if (conn.detectBuf.size() >= 4) {
                    // If first bytes clearly aren't h2 preface, switch to HTTP/1.1
                    if (memcmp(conn.detectBuf.data(), "PRI ", 4) != 0) {
                        conn.protocol = ServerConn::HTTP1;
                        H1HandleData(conn, reinterpret_cast<const char*>(conn.detectBuf.data()),
                                     conn.detectBuf.size());
                        conn.detectBuf.clear();
                        conn.detectBuf.shrink_to_fit();
                    }
                }
            } else if (conn.protocol == ServerConn::HTTP1) {
                H1HandleData(conn, buf, n);
            } else if (conn.protocol == ServerConn::HTTP2) {
                ssize_t consumed = nghttp2_session_mem_recv(conn.h2session,
                    reinterpret_cast<const uint8_t*>(buf), n);
                if (consumed < 0) {
                    SLOG(SPRING_LOG_ERROR, "h2 recv error: %s",
                         nghttp2_strerror((int)consumed));
                    pendingClose.push_back(conn.fd);
                    return;
                }
                H2FlushSession(conn);
            }
        }
    }

    bool HandleWrite(ServerConn& conn) {
        while (!conn.writeBuf.empty()) {
            ssize_t n = send(conn.fd, conn.writeBuf.data(), conn.writeBuf.size(), 0);
            if (n < 0) {
                if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
                return false;
            }
            conn.writeBuf.erase(0, n);
        }
        return true;
    }

    void CloseConnection(int fd) {
        auto it = connections.find(fd);
        if (it == connections.end()) return;
        connections.erase(it);  // destructor closes fd and frees nghttp2 session
    }

    // ── SSE delivery ──

    void DrainSSEQueue() {
        std::vector<SSEEvent> events;
        {
            std::lock_guard<std::mutex> lock(sseMutex);
            events.swap(sseQueue);
        }

        for (auto& ev : events) {
            if (ev.channelId >= sseChannels.size()) continue;

            // Format the SSE frame
            std::string frame;
            if (!ev.event.empty()) {
                frame += "event: ";
                frame += ev.event;
                frame += "\n";
            }
            frame += "data: ";
            frame += ev.data;
            frame += "\n\n";

            // Send to all matching subscribers
            for (auto& [fd, conn] : connections) {
                if (!conn) continue;

                // HTTP/1.1 SSE subscriber
                if (conn->protocol == ServerConn::HTTP1 && conn->h1IsSSE &&
                    conn->h1SSEChannelId == ev.channelId) {
                    conn->writeBuf += frame;
                }

                // HTTP/2 SSE streams
                if (conn->protocol == ServerConn::HTTP2) {
                    for (auto& [sid, stream] : conn->h2streams) {
                        if (stream.isSSE && stream.sseChannelId == ev.channelId) {
                            stream.sseQueue.push_back(frame);
                            nghttp2_session_resume_data(conn->h2session, sid);
                        }
                    }
                    H2FlushSession(*conn);
                }
            }
        }
    }

    void WakeEventLoop() {
        char c = 1;
        (void)write(wakePipe[1], &c, 1);
    }
};

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

NetworkServer::NetworkServer() : impl(std::make_unique<Impl>()) {}
NetworkServer::~NetworkServer() { Stop(); }

void NetworkServer::AddHttpGet(const std::string& pattern, RouteAuth auth, HttpGetHandler handler) {
    httpGetHandlers.push_back({pattern, auth, std::move(handler)});
}

void NetworkServer::AddHttpPost(const std::string& pattern, RouteAuth auth, HttpPostHandler handler) {
    httpPostHandlers.push_back({pattern, auth, std::move(handler)});
}

void NetworkServer::SetRouteAuthCallbacks(RouteAuthCallbacks callbacks) {
    routeAuthCallbacks = std::move(callbacks);
}

std::vector<RouteInfo> NetworkServer::GetRegisteredRoutes() const {
    std::vector<RouteInfo> out;
    out.reserve(httpGetHandlers.size() + httpPostHandlers.size());
    for (auto& r : httpGetHandlers) out.push_back({"GET", r.pattern, r.auth});
    for (auto& r : httpPostHandlers) out.push_back({"POST", r.pattern, r.auth});
    return out;
}

std::string NetworkServer::CurrentQueryString() {
    return tl_queryString;
}

HttpResponse NetworkServer::SafeInvokeForTest(const std::string& path,
                                               const std::function<HttpResponse()>& fn) {
    return SafeInvoke(path, fn);
}

uint32_t NetworkServer::AddSSE(const std::string& pattern) {
    uint32_t id = (uint32_t)impl->sseChannels.size();
    impl->sseChannels.push_back({pattern});
    return id;
}

void NetworkServer::SendSSE(uint32_t channelId, const std::string& data,
                             const std::string& event) {
    {
        std::lock_guard<std::mutex> lock(impl->sseMutex);
        impl->sseQueue.push_back({channelId, data, event});
    }
    impl->WakeEventLoop();
}

bool NetworkServer::Start(int port) {
    if (running.load()) return false;

    // Set handler references for Impl
    impl->getHandlers = &httpGetHandlers;
    impl->postHandlers = &httpPostHandlers;
    impl->authCallbacks = &routeAuthCallbacks;

    // Create wakeup pipe
    if (pipe(impl->wakePipe) < 0) {
        SLOG(SPRING_LOG_ERROR, "failed to create pipe: %s", strerror(errno));
        return false;
    }
    SetNonBlocking(impl->wakePipe[0]);
    SetNonBlocking(impl->wakePipe[1]);

    running.store(true);
    networkThread = std::thread(&NetworkServer::NetworkThreadFunc, this, port);
    return true;
}

void NetworkServer::Stop() {
    if (!running.load()) return;
    running.store(false);
    impl->WakeEventLoop();

    if (networkThread.joinable())
        networkThread.join();

    // Cleanup
    impl->connections.clear();
    if (impl->listenFd >= 0) { ::close(impl->listenFd); impl->listenFd = -1; }
    if (impl->wakePipe[0] >= 0) { ::close(impl->wakePipe[0]); impl->wakePipe[0] = -1; }
    if (impl->wakePipe[1] >= 0) { ::close(impl->wakePipe[1]); impl->wakePipe[1] = -1; }
}

// ═══════════════════════════════════════════════════════════════════════
// Event loop
// ═══════════════════════════════════════════════════════════════════════

void NetworkServer::NetworkThreadFunc(int port) {
    // Create listen socket — dual-stack IPv6 (accepts both IPv4 and IPv6)
    impl->listenFd = socket(AF_INET6, SOCK_STREAM, 0);
    if (impl->listenFd < 0) {
        SLOG(SPRING_LOG_ERROR, "socket() failed: %s", strerror(errno));
        return;
    }

    int one = 1;
    int zero = 0;
    // SO_REUSEADDR lets a fresh server rebind this port while a prior
    // server's *connections* linger in TIME_WAIT. We deliberately do
    // NOT set SO_REUSEPORT: it let two *live* game servers bind the same
    // port, and the kernel then round-robined client connections across
    // both — a client auth'd for one room silently landed on another
    // (or on a stale/zombie server) with the wrong roster and defs. With
    // it gone a colliding bind() fails loudly instead of sharing. The
    // in-place restart (execvp) still rebinds cleanly: Stop() closes this
    // fd first, and FD_CLOEXEC below closes it on exec as a backstop.
    setsockopt(impl->listenFd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    fcntl(impl->listenFd, F_SETFD, fcntl(impl->listenFd, F_GETFD) | FD_CLOEXEC);
    // Dual-stack: accept both IPv4 and IPv6 on the same socket
    setsockopt(impl->listenFd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof(zero));
    SetNonBlocking(impl->listenFd);

    struct sockaddr_in6 addr{};
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons(port);

    if (bind(impl->listenFd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        SLOG(SPRING_LOG_ERROR, "bind(%d) failed: %s", port, strerror(errno));
        ::close(impl->listenFd);
        impl->listenFd = -1;
        return;
    }

    if (listen(impl->listenFd, 128) < 0) {
        SLOG(SPRING_LOG_ERROR, "listen() failed: %s", strerror(errno));
        ::close(impl->listenFd);
        impl->listenFd = -1;
        return;
    }

    SLOG(SPRING_LOG_NOTICE, "listening on port %d (HTTP/2 h2c + HTTP/1.1)", port);

    // Event loop
    while (running.load()) {
        // Build poll set
        std::vector<struct pollfd> fds;
        fds.push_back({impl->listenFd, POLLIN, 0});
        fds.push_back({impl->wakePipe[0], POLLIN, 0});

        for (auto& [fd, conn] : impl->connections) {
            short events = POLLIN;
            if (!conn->writeBuf.empty()) events |= POLLOUT;
            fds.push_back({fd, events, 0});
        }

        int ret = poll(fds.data(), fds.size(), 100);  // 100ms timeout
        if (ret < 0) {
            if (errno == EINTR) continue;
            SLOG(SPRING_LOG_ERROR, "poll() error: %s", strerror(errno));
            break;
        }

        // Process events
        for (auto& pfd : fds) {
            if (pfd.revents == 0) continue;

            // Listen socket — accept new connections
            if (pfd.fd == impl->listenFd) {
                if (pfd.revents & POLLIN) impl->AcceptConnections();
                continue;
            }

            // Wake pipe — drain and process SSE events
            if (pfd.fd == impl->wakePipe[0]) {
                char drain[64];
                while (read(impl->wakePipe[0], drain, sizeof(drain)) > 0) {}
                continue;
            }

            // Client connection
            auto it = impl->connections.find(pfd.fd);
            if (it == impl->connections.end()) continue;
            auto& conn = *it->second;

            if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
                impl->pendingClose.push_back(pfd.fd);
                continue;
            }
            if (pfd.revents & POLLIN) {
                impl->HandleRead(conn);
            }
            if (pfd.revents & POLLOUT) {
                if (!impl->HandleWrite(conn)) {
                    impl->pendingClose.push_back(pfd.fd);
                }
            }
        }

        // Process SSE event queue
        impl->DrainSSEQueue();

        // Flush write buffers for connections that got SSE data
        for (auto& [fd, conn] : impl->connections) {
            if (!conn->writeBuf.empty()) {
                impl->HandleWrite(*conn);
            }
        }

        // Close dead connections
        for (int fd : impl->pendingClose) {
            impl->CloseConnection(fd);
        }
        impl->pendingClose.clear();
    }

    SLOG(SPRING_LOG_INFO, "network thread exiting");
}
