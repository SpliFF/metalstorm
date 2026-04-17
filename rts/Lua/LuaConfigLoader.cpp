/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "LuaConfigLoader.h"
#include "LuaParser.h"

#include "System/FileSystem/VFSModes.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "lua-config"

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

namespace {

/// Wrap a block of text in a Lua long-bracket literal, picking an
/// equals-sign level that doesn't conflict with any `]=*]` sequence
/// inside the body. For typical JSON content this almost always
/// picks level 0 (`[[ ... ]]`), but we scan for nested brackets
/// defensively so we never produce invalid Lua.
std::string ToLongStringLiteral(const std::string& body) {
    int level = 0;
    for (;; ++level) {
        std::string needle = "]";
        for (int i = 0; i < level; ++i) needle += "=";
        needle += "]";
        if (body.find(needle) == std::string::npos) break;
        if (level > 32) break; // absurd; give up defensively
    }
    std::string eq(level, '=');
    return "[" + eq + "[" + body + "]" + eq + "]";
}

std::string ReadFileBytes(const fs::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

std::unique_ptr<LuaParser> LoadFromLuaFile(const std::string& luaPath) {
    auto parser = std::make_unique<LuaParser>(
        luaPath,
        SPRING_VFS_RAW,
        SPRING_VFS_RAW,
        LuaParser::boolean{false},  // unsynced — config load happens outside the sim tick
        LuaParser::boolean{true});  // auto-setup

    if (!parser->Execute()) {
        SLOG(SPRING_LOG_ERROR,
            "failed to parse %s: %s",
            luaPath.c_str(), parser->GetErrorLog().c_str());
        return nullptr;
    }
    if (!parser->GetErrorLog().empty()) {
        SLOG(SPRING_LOG_WARNING,
            "non-fatal warnings parsing %s: %s",
            luaPath.c_str(), parser->GetErrorLog().c_str());
    }
    return parser;
}

std::unique_ptr<LuaParser> LoadFromJsonFile(const std::string& jsonPath) {
    // Read JSON once in C++, wrap it in a Lua shim that decodes via
    // the `json` global LuaParser installs in SetupEnv. We can't use
    // `VFS.LoadFile` here because the JSON file lives on a raw disk
    // path that may not be under any registered content root — and
    // the Lua sandbox nils out `io.open` / `dofile` / `loadfile`, so
    // inlining the payload as a long-bracket literal is the cleanest
    // way to hand it to the parser.
    const std::string payload = ReadFileBytes(jsonPath);
    if (payload.empty()) {
        SLOG(SPRING_LOG_ERROR,
            "%s: empty or unreadable",
            jsonPath.c_str());
        return nullptr;
    }

    const std::string shim =
        "return json.decode(" + ToLongStringLiteral(payload) + ")\n";

    auto parser = std::make_unique<LuaParser>(
        shim,
        SPRING_VFS_RAW,
        0,
        LuaParser::boolean{false},
        LuaParser::boolean{true});

    if (!parser->Execute()) {
        SLOG(SPRING_LOG_ERROR,
            "failed to decode %s as JSON: %s",
            jsonPath.c_str(), parser->GetErrorLog().c_str());
        return nullptr;
    }
    return parser;
}

} // namespace

namespace LuaConfig {

std::unique_ptr<LuaParser> Load(const std::string& basePath) {
    const std::string luaPath  = basePath + kLuaSuffix;
    const std::string jsonPath = basePath + kJsonSuffix;

    // Author-supplied Lua wins if both are present — the .config.lua
    // is what a human hand-edits, the .config.json is what the tool
    // chain spits out.
    if (fs::exists(luaPath)) {
        return LoadFromLuaFile(luaPath);
    }
    if (fs::exists(jsonPath)) {
        return LoadFromJsonFile(jsonPath);
    }
    return nullptr;
}

std::unique_ptr<LuaParser> LoadJson(const std::string& basePath) {
    const std::string jsonPath = basePath + kJsonSuffix;
    if (fs::exists(jsonPath)) {
        return LoadFromJsonFile(jsonPath);
    }
    return nullptr;
}

} // namespace LuaConfig
