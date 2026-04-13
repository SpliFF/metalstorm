// libspringapi — HTTP-based API for Spring RTS Web servers.
//
// Uses raw POSIX sockets for HTTP. No external dependencies
// beyond the C standard library and POSIX networking.

#include "springapi.h"

#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netdb.h>
#include <unistd.h>

namespace springapi {

namespace {

// Parse "http://host:port" into host and port components.
// Returns false if the URL doesn't match.
bool parseUrl(const std::string& url, std::string& host, int& port, std::string& path) {
    std::string s = url;
    // Strip protocol
    if (s.rfind("http://", 0) == 0) s = s.substr(7);
    else if (s.rfind("https://", 0) == 0) return false; // no TLS support

    // Split host:port from path
    auto slashPos = s.find('/');
    std::string hostPort;
    if (slashPos != std::string::npos) {
        hostPort = s.substr(0, slashPos);
        path = s.substr(slashPos);
    } else {
        hostPort = s;
        path = "/";
    }

    // Split host and port
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

// Perform a raw HTTP request and return the response body.
std::string httpRequest(const std::string& method, const std::string& url,
                        const std::string& body = "") {
    std::string host, path;
    int port;
    if (!parseUrl(url, host, port, path)) return "";

    // Resolve host
    struct addrinfo hints{}, *res;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0)
        return "";

    int sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) { freeaddrinfo(res); return ""; }

    if (connect(sock, res->ai_addr, res->ai_addrlen) < 0) {
        close(sock);
        freeaddrinfo(res);
        return "";
    }
    freeaddrinfo(res);

    // Build HTTP request
    std::ostringstream req;
    req << method << " " << path << " HTTP/1.1\r\n";
    req << "Host: " << host << ":" << port << "\r\n";
    req << "Connection: close\r\n";
    if (!body.empty()) {
        req << "Content-Type: application/json\r\n";
        req << "Content-Length: " << body.size() << "\r\n";
    }
    req << "\r\n";
    if (!body.empty()) req << body;

    std::string reqStr = req.str();
    send(sock, reqStr.c_str(), reqStr.size(), 0);

    // Read response
    std::string response;
    char buf[4096];
    while (true) {
        ssize_t n = recv(sock, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, n);
    }
    close(sock);

    // Strip HTTP headers — find \r\n\r\n
    auto headerEnd = response.find("\r\n\r\n");
    if (headerEnd == std::string::npos) return response;

    std::string respBody = response.substr(headerEnd + 4);

    // Handle chunked transfer encoding
    auto tePos = response.find("Transfer-Encoding: chunked");
    if (tePos != std::string::npos && tePos < headerEnd) {
        // Decode chunked body
        std::string decoded;
        size_t pos = 0;
        while (pos < respBody.size()) {
            auto lineEnd = respBody.find("\r\n", pos);
            if (lineEnd == std::string::npos) break;
            long chunkSize = strtol(respBody.c_str() + pos, nullptr, 16);
            if (chunkSize <= 0) break;
            pos = lineEnd + 2;
            if (pos + chunkSize <= respBody.size()) {
                decoded.append(respBody, pos, chunkSize);
            }
            pos += chunkSize + 2; // skip chunk data + \r\n
        }
        return decoded;
    }

    return respBody;
}

// Simple JSON string escape
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

// Extract a string value from JSON by key. Minimal, no nesting.
std::string jsonExtract(const std::string& json, const std::string& key) {
    std::string needle = "\"" + key + "\"";
    auto pos = json.find(needle);
    if (pos == std::string::npos) return "";

    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos++;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;

    if (pos >= json.size()) return "";

    // String value
    if (json[pos] == '"') {
        auto end = pos + 1;
        while (end < json.size() && json[end] != '"') {
            if (json[end] == '\\') end++;
            end++;
        }
        return json.substr(pos + 1, end - pos - 1);
    }
    // Boolean or number
    auto end = json.find_first_of(",}\n ", pos);
    if (end == std::string::npos) end = json.size();
    return json.substr(pos, end - pos);
}

} // namespace

// ─── Public API ───

std::string httpGet(const std::string& url) {
    return httpRequest("GET", url);
}

std::string httpPost(const std::string& url, const std::string& jsonBody) {
    return httpRequest("POST", url, jsonBody);
}

ExecResult exec(const std::string& serverUrl, const std::string& scope,
                const std::string& code) {
    std::string body = "{\"scope\":\"" + jsonEscape(scope)
        + "\",\"code\":\"" + jsonEscape(code) + "\"}";
    std::string url = serverUrl;
    if (url.back() != '/') url += '/';
    url += "api/exec";

    std::string resp = httpPost(url, body);
    if (resp.empty()) return {false, "connection failed"};

    ExecResult r;
    r.success = jsonExtract(resp, "success") == "true";
    r.output = jsonExtract(resp, "output");
    return r;
}

ExecResult lobbyExec(const std::string& lobbyUrl, const std::string& scope,
                     const std::string& code) {
    return exec(lobbyUrl, scope, code); // same endpoint
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
