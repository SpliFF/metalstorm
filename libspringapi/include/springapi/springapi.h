// libspringapi — client library for Spring RTS Web servers.
//
// Provides streamlined interaction with Spring lobby, game, and log
// servers over HTTP and WebRTC. Link this into your own tools, lobbies,
// bots, or monitoring systems.
//
// Three interfaces:
//   1. HTTP — auth, exec, logs, processes (synchronous, request/response)
//   2. WebRTC reliable channel — FlatBuffer messages (commands, events)
//   3. WebRTC unreliable channel — entity/projectile state (raw binary)
//
// Build: cmake -B build && cmake --build build
// Link:  target_link_libraries(mytool PRIVATE springapi)

#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace springapi {

// ─── HTTP API (synchronous, request/response) ───

/// Auth result from login/register.
struct AuthResult {
    bool success = false;
    std::string token;
    std::string error;
    int64_t userId = 0;
    std::string username;
    std::string role;
};

/// Exec result from command execution.
struct ExecResult {
    bool success = false;
    std::string output;
};

/// Login to a server via HTTP. Returns a token for subsequent requests.
AuthResult login(const std::string& serverUrl,
                 const std::string& username, const std::string& password);

/// Register a new account. Auto-logs in on success.
///
/// `faction` is **optional at this layer, with passthrough semantics**: when
/// non-empty it is sent as the request's `faction` field, and when empty the
/// field is omitted from the body entirely. libspringapi is a transport for
/// the HTTP API, not a policy layer — whether a faction is required is the
/// *server's* rule and it is game-scoped, not universal (the lobby validates
/// against a registry built only from Metalstorm's gamedata/sidedata.lua, so
/// a lobby that doesn't serve Metalstorm has no valid faction to send). Making
/// the parameter mandatory here would hardcode one deployment's policy and
/// leave callers of every other deployment with nothing legal to pass.
///
/// Against a server that does require one, omitting it yields
/// `success == false` with `error == "faction is required"`; an out-of-registry
/// key yields `error == "unknown faction"`. Query the valid keys with
/// `httpGet(serverUrl + "/api/factions/<gameId>")`.
AuthResult registerUser(const std::string& serverUrl,
                        const std::string& username, const std::string& password,
                        const std::string& faction = "");

/// Execute a command in a scope on a game server (via HTTP POST /api/exec).
/// Requires a token from login().
ExecResult exec(const std::string& serverUrl, const std::string& scope,
                const std::string& code, const std::string& token);

/// Query logs from the log server (via HTTP GET /api/logs).
std::string getLogs(const std::string& logServerUrl, int roomId = 0,
                    int level = 0, int limit = 50,
                    const std::string& section = "",
                    const std::string& scope = "");

/// Search logs from the log server.
std::string searchLogs(const std::string& logServerUrl,
                       const std::string& query,
                       int level = 0, int limit = 50);

/// Get game server process list from the lobby.
std::string getProcesses(const std::string& lobbyUrl);

/// Raw HTTP GET.
std::string httpGet(const std::string& url);

/// Raw HTTP POST with JSON body and optional Bearer token.
std::string httpPost(const std::string& url, const std::string& jsonBody,
                     const std::string& authToken = "");

// ─── WebRTC API (asynchronous, event-driven) ───

/// Callback for received binary data on a channel.
using DataCallback = std::function<void(const uint8_t* data, size_t len)>;

/// Callback for connection state changes.
using StateCallback = std::function<void(const std::string& state)>;

/// Opaque handle to a WebRTC peer connection.
class RtcConnection;
using RtcConnectionPtr = std::shared_ptr<RtcConnection>;

/// Create a WebRTC connection to a game server.
/// Performs HTTP signaling (POST /api/rtc/offer) using the auth token.
/// Returns nullptr on failure.
///
/// Usage:
///   auto conn = springapi::connectRtc("http://localhost:9100", token);
///   conn->onControlMessage([](const uint8_t* data, size_t len) { ... });
///   conn->onStateMessage([](const uint8_t* data, size_t len) { ... });
///   conn->sendControl(data, len);  // reliable channel
///   conn->sendState(data, len);    // unreliable channel
RtcConnectionPtr connectRtc(const std::string& serverUrl,
                             const std::string& authToken);

/// WebRTC connection interface.
class RtcConnection {
public:
    virtual ~RtcConnection() = default;

    /// Set callback for messages on the reliable control channel.
    virtual void onControlMessage(DataCallback cb) = 0;

    /// Set callback for messages on the unreliable state channel.
    virtual void onStateMessage(DataCallback cb) = 0;

    /// Set callback for connection state changes.
    virtual void onStateChange(StateCallback cb) = 0;

    /// Send data on the reliable control channel.
    virtual bool sendControl(const uint8_t* data, size_t len) = 0;

    /// Send data on the unreliable state channel.
    virtual bool sendState(const uint8_t* data, size_t len) = 0;

    /// Check if the connection is open.
    virtual bool isOpen() const = 0;

    /// Close the connection.
    virtual void close() = 0;

    /// Get the client ID assigned by the server.
    virtual uint32_t clientId() const = 0;
};

// ─── JSON helpers (useful for parsing server responses) ───

/// Extract a string value from a JSON object by key. Minimal, flat.
std::string jsonExtract(const std::string& json, const std::string& key);

/// Escape a string for inclusion in a JSON value.
std::string jsonEscape(const std::string& s);

} // namespace springapi
