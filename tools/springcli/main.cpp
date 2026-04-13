// springcli — command-line interface for Spring RTS Web servers.
//
// Usage:
//   springcli exec <scope> <code> [--server URL]
//   springcli lua <code> [--server URL] [--scope LuaRules|LuaGaia]
//   springcli state [--server URL]
//   springcli units [--server URL] [--team N]
//   springcli defs [--server URL]
//   springcli logs [--log-server URL] [--level N] [--section S] [--search Q] [--limit N]
//   springcli processes [--lobby URL]
//   springcli sql <query> [--lobby URL]
//   springcli get <url>
//   springcli post <url> <json-body>
//
// Environment variables for defaults:
//   SPRING_SERVER=http://localhost:9100
//   SPRING_LOBBY=http://localhost:8011
//   SPRING_LOG_SERVER=http://localhost:8010
//
// Exit codes: 0 = success, 1 = error/failure, 2 = usage error

#include "springapi.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static const char* envOr(const char* name, const char* fallback) {
    const char* v = getenv(name);
    return (v && v[0]) ? v : fallback;
}

static void usage() {
    fprintf(stderr,
        "springcli — command-line interface for Spring RTS Web servers\n"
        "\n"
        "Commands:\n"
        "  exec <scope> <code>       Execute code in a scope on the game server\n"
        "  lua <code>                Shorthand for: exec LuaRules <code>\n"
        "  state                     Get sim state summary\n"
        "  units [--team N]          List units\n"
        "  defs                      List def counts\n"
        "  frame                     Get current sim frame\n"
        "  pause / unpause           Pause/resume sim\n"
        "  speed <N>                 Set game speed\n"
        "  logs [--search Q]         Query log server\n"
        "  processes                 List game server processes\n"
        "  sql <query>               Execute SQL on lobby\n"
        "  get <url>                 Raw HTTP GET\n"
        "  post <url> <json>         Raw HTTP POST\n"
        "\n"
        "Options:\n"
        "  --server URL              Game server (default: $SPRING_SERVER or localhost:9100)\n"
        "  --lobby URL               Lobby server (default: $SPRING_LOBBY or localhost:8011)\n"
        "  --log-server URL          Log server (default: $SPRING_LOG_SERVER or localhost:8010)\n"
        "  --scope SCOPE             Lua scope (default: LuaRules)\n"
        "  --level N                 Min log level (0-5)\n"
        "  --section S               Filter logs by section\n"
        "  --search Q                Search log messages\n"
        "  --limit N                 Max results (default: 50)\n"
        "  --team N                  Filter units by team\n"
        "  --json                    Output raw JSON (no formatting)\n"
        "  -q                        Quiet: output only the result value\n"
        "\n"
        "Environment:\n"
        "  SPRING_SERVER             Default game server URL\n"
        "  SPRING_LOBBY              Default lobby URL\n"
        "  SPRING_LOG_SERVER         Default log server URL\n"
    );
}

int main(int argc, char** argv) {
    if (argc < 2) { usage(); return 2; }

    // Defaults from environment
    std::string serverUrl = envOr("SPRING_SERVER", "http://localhost:9100");
    std::string lobbyUrl = envOr("SPRING_LOBBY", "http://localhost:8011");
    std::string logServerUrl = envOr("SPRING_LOG_SERVER", "http://localhost:8010");
    std::string scope = "LuaRules";
    int level = 0, limit = 50, team = -1;
    std::string section, search;
    bool rawJson = false, quiet = false;

    // Parse trailing options (after command + positional args)
    auto parseOpts = [&](int start) {
        for (int i = start; i < argc; i++) {
            if (strcmp(argv[i], "--server") == 0 && i+1 < argc) serverUrl = argv[++i];
            else if (strcmp(argv[i], "--lobby") == 0 && i+1 < argc) lobbyUrl = argv[++i];
            else if (strcmp(argv[i], "--log-server") == 0 && i+1 < argc) logServerUrl = argv[++i];
            else if (strcmp(argv[i], "--scope") == 0 && i+1 < argc) scope = argv[++i];
            else if (strcmp(argv[i], "--level") == 0 && i+1 < argc) level = atoi(argv[++i]);
            else if (strcmp(argv[i], "--section") == 0 && i+1 < argc) section = argv[++i];
            else if (strcmp(argv[i], "--search") == 0 && i+1 < argc) search = argv[++i];
            else if (strcmp(argv[i], "--limit") == 0 && i+1 < argc) limit = atoi(argv[++i]);
            else if (strcmp(argv[i], "--team") == 0 && i+1 < argc) team = atoi(argv[++i]);
            else if (strcmp(argv[i], "--json") == 0) rawJson = true;
            else if (strcmp(argv[i], "-q") == 0) quiet = true;
        }
    };

    std::string cmd = argv[1];

    // ─── exec <scope> <code> ───
    if (cmd == "exec") {
        if (argc < 4) { fprintf(stderr, "Usage: springcli exec <scope> <code> [--server URL]\n"); return 2; }
        std::string execScope = argv[2];
        std::string code = argv[3];
        parseOpts(4);

        auto r = springapi::exec(serverUrl, execScope, code);
        if (rawJson) {
            printf("{\"success\":%s,\"output\":\"%s\"}\n",
                   r.success ? "true" : "false", r.output.c_str());
        } else if (quiet) {
            printf("%s\n", r.output.c_str());
        } else {
            if (!r.success) fprintf(stderr, "error: ");
            printf("%s\n", r.output.c_str());
        }
        return r.success ? 0 : 1;
    }

    // ─── lua <code> ───
    if (cmd == "lua") {
        if (argc < 3) { fprintf(stderr, "Usage: springcli lua <code> [--scope S] [--server URL]\n"); return 2; }
        std::string code = argv[2];
        parseOpts(3);

        auto r = springapi::exec(serverUrl, scope, code);
        if (quiet) {
            printf("%s\n", r.output.c_str());
        } else {
            if (!r.success) fprintf(stderr, "error: ");
            printf("%s\n", r.output.c_str());
        }
        return r.success ? 0 : 1;
    }

    // ─── Shorthand server commands ───
    if (cmd == "state" || cmd == "frame" || cmd == "defs" ||
        cmd == "pause" || cmd == "unpause") {
        parseOpts(2);
        auto r = springapi::exec(serverUrl, "server", cmd);
        printf("%s\n", r.output.c_str());
        return r.success ? 0 : 1;
    }

    if (cmd == "units") {
        parseOpts(2);
        std::string code = team >= 0 ? "units " + std::to_string(team) : "units";
        auto r = springapi::exec(serverUrl, "server", code);
        printf("%s\n", r.output.c_str());
        return r.success ? 0 : 1;
    }

    if (cmd == "speed") {
        if (argc < 3) { fprintf(stderr, "Usage: springcli speed <N>\n"); return 2; }
        parseOpts(3);
        auto r = springapi::exec(serverUrl, "server", "speed " + std::string(argv[2]));
        printf("%s\n", r.output.c_str());
        return r.success ? 0 : 1;
    }

    // ─── logs ───
    if (cmd == "logs") {
        parseOpts(2);
        std::string result;
        if (!search.empty()) {
            result = springapi::searchLogs(logServerUrl, search, level, limit);
        } else {
            result = springapi::getLogs(logServerUrl, 0, level, limit, section, scope == "LuaRules" ? "" : scope);
        }
        if (result.empty()) {
            printf("[]\n");
        } else {
            printf("%s\n", result.c_str());
        }
        return 0;
    }

    // ─── processes ───
    if (cmd == "processes" || cmd == "ps") {
        parseOpts(2);
        auto result = springapi::getProcesses(lobbyUrl);
        printf("%s\n", result.c_str());
        return 0;
    }

    // ─── sql ───
    if (cmd == "sql") {
        if (argc < 3) { fprintf(stderr, "Usage: springcli sql <query> [--lobby URL]\n"); return 2; }
        std::string query = argv[2];
        parseOpts(3);
        auto r = springapi::lobbyExec(lobbyUrl, "sql", query);
        if (quiet) {
            printf("%s\n", r.output.c_str());
        } else {
            if (!r.success) fprintf(stderr, "error: ");
            printf("%s\n", r.output.c_str());
        }
        return r.success ? 0 : 1;
    }

    // ─── Raw HTTP ───
    if (cmd == "get") {
        if (argc < 3) { fprintf(stderr, "Usage: springcli get <url>\n"); return 2; }
        auto result = springapi::httpGet(argv[2]);
        printf("%s\n", result.c_str());
        return result.empty() ? 1 : 0;
    }

    if (cmd == "post") {
        if (argc < 4) { fprintf(stderr, "Usage: springcli post <url> <json-body>\n"); return 2; }
        auto result = springapi::httpPost(argv[2], argv[3]);
        printf("%s\n", result.c_str());
        return result.empty() ? 1 : 0;
    }

    // ─── help ───
    if (cmd == "--help" || cmd == "-h" || cmd == "help") {
        usage();
        return 0;
    }

    fprintf(stderr, "Unknown command: %s\nRun: springcli --help\n", cmd.c_str());
    return 2;
}
