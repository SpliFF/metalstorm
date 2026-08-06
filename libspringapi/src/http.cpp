// libspringapi — HTTP/2 (h2c) client implementation.
//
// Uses nghttp2 for HTTP/2 cleartext connections. Falls back to HTTP/1.1
// for servers that don't speak h2c. Supports multiplexed requests.

#include "springapi/springapi.h"

#include <nghttp2/nghttp2.h>

#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include <unistd.h>
#include <poll.h>

namespace springapi {

namespace {

bool parseUrl(const std::string& url, std::string& host, int& port, std::string& path) {
    std::string s = url;
    if (s.rfind("http://", 0) == 0) s = s.substr(7);
    else if (s.rfind("https://", 0) == 0) return false;

    auto slashPos = s.find('/');
    std::string hostPort;
    if (slashPos != std::string::npos) {
        hostPort = s.substr(0, slashPos);
        path = s.substr(slashPos);
    } else {
        hostPort = s;
        path = "/";
    }

    auto colonPos = hostPort.rfind(':');
    if (colonPos != std::string::npos) {
        host = hostPort.substr(0, colonPos);
        port = std::atoi(hostPort.substr(colonPos + 1).c_str());
    } else {
        host = hostPort;
        port = 80;
    }
    return !host.empty() && port > 0;
}

int connectTcp(const std::string& host, int port) {
    struct addrinfo hints{}, *res;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0)
        return -1;

    int sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) { freeaddrinfo(res); return -1; }

    if (connect(sock, res->ai_addr, res->ai_addrlen) < 0) {
        close(sock);
        freeaddrinfo(res);
        return -1;
    }
    freeaddrinfo(res);

    // Enable TCP_NODELAY for lower latency
    int one = 1;
    setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    return sock;
}

// ── nghttp2 h2c client session ──

struct H2ClientStream {
    int32_t streamId = 0;
    std::string responseBody;
    bool complete = false;
};

struct H2ClientSession {
    int fd = -1;
    nghttp2_session* session = nullptr;
    H2ClientStream* activeStream = nullptr;

    ~H2ClientSession() {
        if (session) nghttp2_session_del(session);
        if (fd >= 0) close(fd);
    }
};

static ssize_t h2SendCallback(nghttp2_session* session,
                                const uint8_t* data, size_t length,
                                int flags, void* user_data) {
    auto* ctx = static_cast<H2ClientSession*>(user_data);
    ssize_t sent = send(ctx->fd, data, length, 0);
    if (sent < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return NGHTTP2_ERR_WOULDBLOCK;
        return NGHTTP2_ERR_CALLBACK_FAILURE;
    }
    return sent;
}

static int h2OnFrameRecv(nghttp2_session* session,
                           const nghttp2_frame* frame, void* user_data) {
    auto* ctx = static_cast<H2ClientSession*>(user_data);
    if (ctx->activeStream && frame->hd.stream_id == ctx->activeStream->streamId) {
        if (frame->hd.flags & NGHTTP2_FLAG_END_STREAM) {
            ctx->activeStream->complete = true;
        }
    }
    return 0;
}

static int h2OnDataChunkRecv(nghttp2_session* session, uint8_t flags,
                               int32_t stream_id, const uint8_t* data,
                               size_t len, void* user_data) {
    auto* ctx = static_cast<H2ClientSession*>(user_data);
    if (ctx->activeStream && stream_id == ctx->activeStream->streamId) {
        ctx->activeStream->responseBody.append(reinterpret_cast<const char*>(data), len);
    }
    return 0;
}

/// Single-request HTTP/2 h2c client. Connects, sends one request, reads response.
std::string h2cRequest(const std::string& method, const std::string& url,
                        const std::string& body = "",
                        const std::string& authToken = "") {
    std::string host, path;
    int port;
    if (!parseUrl(url, host, port, path)) return "";

    int fd = connectTcp(host, port);
    if (fd < 0) return "";

    H2ClientSession ctx;
    ctx.fd = fd;

    // Create nghttp2 client session with send callback
    nghttp2_session_callbacks* cbs;
    nghttp2_session_callbacks_new(&cbs);
    nghttp2_session_callbacks_set_send_callback(cbs, h2SendCallback);
    nghttp2_session_callbacks_set_on_frame_recv_callback(cbs, h2OnFrameRecv);
    nghttp2_session_callbacks_set_on_data_chunk_recv_callback(cbs, h2OnDataChunkRecv);
    nghttp2_session_client_new(&ctx.session, cbs, &ctx);
    nghttp2_session_callbacks_del(cbs);

    // Send client connection preface + SETTINGS
    nghttp2_settings_entry settings[] = {
        {NGHTTP2_SETTINGS_MAX_CONCURRENT_STREAMS, 100},
    };
    nghttp2_submit_settings(ctx.session, NGHTTP2_FLAG_NONE,
                             settings, sizeof(settings)/sizeof(settings[0]));

    // Build headers — store all value strings to keep them alive until
    // nghttp2_submit_request copies the nv array.
    std::string authority = host + ":" + std::to_string(port);
    std::string scheme = "http";
    std::string authVal = authToken.empty() ? "" : "Bearer " + authToken;
    std::string contentType = "application/json";

    std::vector<nghttp2_nv> hdrs;
    auto addHdr = [&](const char* name, const std::string& val) {
        hdrs.push_back({
            (uint8_t*)name, (uint8_t*)val.data(),
            strlen(name), val.size(),
            NGHTTP2_NV_FLAG_NO_COPY_NAME | NGHTTP2_NV_FLAG_NO_COPY_VALUE
        });
    };

    addHdr(":method", method);
    addHdr(":path", path);
    addHdr(":scheme", scheme);
    addHdr(":authority", authority);
    if (!authToken.empty()) addHdr("authorization", authVal);
    if (!body.empty()) addHdr("content-type", contentType);

    // Data provider for POST body
    struct BodyProvider {
        const std::string* body;
        size_t offset = 0;
    };
    BodyProvider bp{&body, 0};

    nghttp2_data_provider prd;
    prd.source.ptr = &bp;
    prd.read_callback = [](nghttp2_session*, int32_t, uint8_t* buf,
                            size_t length, uint32_t* data_flags,
                            nghttp2_data_source* source,
                            void*) -> ssize_t {
        auto* bp = static_cast<BodyProvider*>(source->ptr);
        size_t remaining = bp->body->size() - bp->offset;
        if (remaining == 0) {
            *data_flags |= NGHTTP2_DATA_FLAG_EOF;
            return 0;
        }
        size_t n = std::min(remaining, length);
        memcpy(buf, bp->body->data() + bp->offset, n);
        bp->offset += n;
        if (bp->offset >= bp->body->size())
            *data_flags |= NGHTTP2_DATA_FLAG_EOF;
        return (ssize_t)n;
    };

    H2ClientStream stream;
    ctx.activeStream = &stream;

    int32_t sid = nghttp2_submit_request(ctx.session, nullptr,
                                          hdrs.data(), hdrs.size(),
                                          body.empty() ? nullptr : &prd,
                                          &stream);
    if (sid < 0) return "";
    stream.streamId = sid;

    // Send all pending data (preface + settings + request)
    nghttp2_session_send(ctx.session);

    // Read response
    uint8_t buf[16384];
    while (!stream.complete) {
        struct pollfd pfd = {fd, POLLIN, 0};
        int ret = poll(&pfd, 1, 10000);  // 10s timeout
        if (ret <= 0) break;

        ssize_t n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;

        ssize_t consumed = nghttp2_session_mem_recv(ctx.session, buf, n);
        if (consumed < 0) break;

        // Send any pending data (WINDOW_UPDATE, etc.)
        nghttp2_session_send(ctx.session);
    }

    return stream.responseBody;
}

/// HTTP/1.1 fallback for servers that don't speak h2c.
std::string http1Request(const std::string& method, const std::string& url,
                          const std::string& body = "",
                          const std::string& authToken = "") {
    std::string host, path;
    int port;
    if (!parseUrl(url, host, port, path)) return "";

    int sock = connectTcp(host, port);
    if (sock < 0) return "";

    std::ostringstream req;
    req << method << " " << path << " HTTP/1.1\r\n";
    req << "Host: " << host << ":" << port << "\r\n";
    req << "Connection: close\r\n";
    if (!authToken.empty())
        req << "Authorization: Bearer " << authToken << "\r\n";
    if (!body.empty()) {
        req << "Content-Type: application/json\r\n";
        req << "Content-Length: " << body.size() << "\r\n";
    }
    req << "\r\n";
    if (!body.empty()) req << body;

    std::string reqStr = req.str();
    send(sock, reqStr.c_str(), reqStr.size(), 0);

    std::string response;
    char buf[4096];
    while (true) {
        ssize_t n = recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, n);
    }
    close(sock);

    auto headerEnd = response.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return response;

    std::string respBody = response.substr(headerEnd + 4);

    // Handle chunked transfer encoding
    if (response.find("Transfer-Encoding: chunked") != std::string::npos &&
        response.find("Transfer-Encoding: chunked") < headerEnd) {
        std::string decoded;
        size_t pos = 0;
        while (pos < respBody.size()) {
            auto lineEnd = respBody.find("\r\n", pos);
            if (lineEnd == std::string::npos) break;
            long chunkSize = strtol(respBody.c_str() + pos, nullptr, 16);
            if (chunkSize <= 0) break;
            pos = lineEnd + 2;
            if (pos + chunkSize <= respBody.size())
                decoded.append(respBody, pos, chunkSize);
            pos += chunkSize + 2;
        }
        return decoded;
    }

    return respBody;
}

/// Try HTTP/2 h2c first, fall back to HTTP/1.1 on failure.
std::string httpRequest(const std::string& method, const std::string& url,
                         const std::string& body = "",
                         const std::string& authToken = "") {
    std::string result = h2cRequest(method, url, body, authToken);
    if (!result.empty()) return result;
    // Fallback to HTTP/1.1
    return http1Request(method, url, body, authToken);
}

} // namespace

// ─── JSON helpers ───

std::string jsonExtract(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    if (pos >= json.size()) return "";
    if (json[pos] == '"') {
        auto end = pos + 1;
        while (end < json.size() && json[end] != '"') {
            if (json[end] == '\\') end++;
            end++;
        }
        return json.substr(pos + 1, end - pos - 1);
    }
    auto end = json.find_first_of(",}\n ", pos);
    if (end == std::string::npos) end = json.size();
    return json.substr(pos, end - pos);
}

std::string jsonEscape(const std::string& s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

// ─── HTTP API ───

std::string httpGet(const std::string& url) {
    return httpRequest("GET", url);
}

std::string httpPost(const std::string& url, const std::string& jsonBody,
                     const std::string& authToken) {
    return httpRequest("POST", url, jsonBody, authToken);
}

AuthResult login(const std::string& serverUrl,
                 const std::string& username, const std::string& password) {
    std::string body = "{\"username\":\"" + jsonEscape(username)
        + "\",\"password\":\"" + jsonEscape(password) + "\"}";
    std::string url = serverUrl + "/api/auth/login";
    std::string resp = httpPost(url, body);
    if (resp.empty()) return {false, "", "connection failed"};

    AuthResult r;
    r.token = jsonExtract(resp, "token");
    r.error = jsonExtract(resp, "error");
    r.success = !r.token.empty();
    if (r.success) {
        r.username = jsonExtract(resp, "username");
        r.role = jsonExtract(resp, "role");
        auto uid = jsonExtract(resp, "user_id");
        r.userId = uid.empty() ? 0 : std::atoll(uid.c_str());
    }
    return r;
}

AuthResult registerUser(const std::string& serverUrl,
                        const std::string& username, const std::string& password,
                        const std::string& faction) {
    // `faction` is passthrough-optional — see the contract note in
    // springapi.h. Omit the field entirely rather than sending "" so a
    // server that treats an empty faction as "unset" and one that treats
    // it as "absent" behave identically.
    std::string body = "{\"username\":\"" + jsonEscape(username)
        + "\",\"password\":\"" + jsonEscape(password) + "\"";
    if (!faction.empty())
        body += ",\"faction\":\"" + jsonEscape(faction) + "\"";
    body += "}";
    std::string url = serverUrl + "/api/auth/register";
    std::string resp = httpPost(url, body);
    if (resp.empty()) return {false, "", "connection failed"};

    AuthResult r;
    r.token = jsonExtract(resp, "token");
    r.error = jsonExtract(resp, "error");
    r.success = !r.token.empty();
    if (r.success) {
        r.username = jsonExtract(resp, "username");
        r.role = jsonExtract(resp, "role");
        auto uid = jsonExtract(resp, "user_id");
        r.userId = uid.empty() ? 0 : std::atoll(uid.c_str());
    }
    return r;
}

ExecResult exec(const std::string& serverUrl, const std::string& scope,
                const std::string& code, const std::string& token) {
    std::string body = "{\"scope\":\"" + jsonEscape(scope)
        + "\",\"code\":\"" + jsonEscape(code) + "\"}";
    std::string url = serverUrl + "/api/exec";
    std::string resp = httpPost(url, body, token);
    if (resp.empty()) return {false, "connection failed"};

    std::string error = jsonExtract(resp, "error");
    if (!error.empty()) return {false, error};

    ExecResult r;
    r.success = jsonExtract(resp, "success") == "true";
    r.output = jsonExtract(resp, "output");
    return r;
}

std::string getLogs(const std::string& logServerUrl, int roomId,
                    int level, int limit,
                    const std::string& section, const std::string& scope) {
    std::ostringstream url;
    url << logServerUrl << "/api/logs/" << roomId
        << "?limit=" << limit << "&level=" << level;
    if (!section.empty()) url << "&section=" << section;
    if (!scope.empty()) url << "&scope=" << scope;
    return httpGet(url.str());
}

std::string searchLogs(const std::string& logServerUrl,
                       const std::string& query,
                       int level, int limit) {
    std::ostringstream url;
    url << logServerUrl << "/api/logs/search?q=" << query
        << "&limit=" << limit << "&level=" << level;
    return httpGet(url.str());
}

std::string getProcesses(const std::string& lobbyUrl) {
    return httpGet(lobbyUrl + "/api/processes");
}

} // namespace springapi
