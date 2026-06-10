#pragma once

#include <atomic>
#include <string>
#include <vector>

struct GameServerContext;
class ContentServer;

// RegisterGameHttpRoutes — registers every HTTP GET/POST handler the game
// server exposes (map heightmap/info, maps list + thumbnail, perf metrics,
// content server, auth + exec endpoints, restart, WebTransport discovery).
// Pure relocation of the registration block that lived inline in
// server_main.cpp; handler bodies are carried over verbatim.
//
// restartRequested / keepRunning are the file-scope atomics owned by main();
// they are passed by reference rather than re-declared as globals in this TU.
void RegisterGameHttpRoutes(GameServerContext& ctx,
                            ContentServer& content,
                            const std::vector<std::string>& contentRoots,
                            const std::string& mapsDir,
                            std::atomic<bool>& restartRequested,
                            std::atomic<bool>& keepRunning);
