// libspringapi — C/C++ API for interacting with Spring RTS Web servers.
//
// Provides HTTP-based command execution, log queries, and process
// management without requiring WebSocket or FlatBuffer dependencies.
// Every function is a synchronous HTTP call that returns plain
// strings or JSON — suitable for CLI tools, scripts, and automation.

#pragma once

#include <string>
#include <vector>

namespace springapi {

/// Result of an exec() call.
struct ExecResult {
    bool success;
    std::string output;
};

/// A log entry from the log server.
struct LogEntry {
    uint64_t id;
    uint64_t timestamp;
    int level;
    std::string section;
    std::string scope;
    std::string process;
    std::string message;
    int frame;
};

/// A game server process entry.
struct ProcessInfo {
    int roomId;
    int port;
    int pid;
    std::string state;
    std::string map;
    std::string game;
};

// ─── Command execution ───

/// Execute a command in a scope on the game server.
/// scope: "LuaRules", "LuaGaia", "server", etc.
/// Uses POST /api/exec on the game server.
ExecResult exec(const std::string& serverUrl, const std::string& scope,
                const std::string& code);

/// Execute a lobby-scope command (sql, lobby).
/// Uses POST /api/exec on the lobby.
ExecResult lobbyExec(const std::string& lobbyUrl, const std::string& scope,
                     const std::string& code);

// ─── Log queries ───

/// Get recent logs from the log server.
std::string getLogs(const std::string& logServerUrl, int roomId = 0,
                    int level = 0, int limit = 50,
                    const std::string& section = "",
                    const std::string& scope = "");

/// Search logs.
std::string searchLogs(const std::string& logServerUrl,
                       const std::string& query,
                       int level = 0, int limit = 50);

// ─── Process management ───

/// Get list of game server processes from the lobby.
std::string getProcesses(const std::string& lobbyUrl);

// ─── Raw HTTP helpers ───

/// Perform an HTTP GET and return the response body.
std::string httpGet(const std::string& url);

/// Perform an HTTP POST with a JSON body and return the response body.
std::string httpPost(const std::string& url, const std::string& jsonBody);

} // namespace springapi
