/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaConfigLoader — unified loader for project configuration files.
 *
 * Every configuration file in this project follows the `.config.lua`
 * / `.config.json` convention:
 *
 *     <basePath>.config.lua    — first choice if it exists
 *     <basePath>.config.json   — second choice, decoded via json-lua
 *
 * JSON is the canonical format that external tools (the model
 * importer, asset pipelines, third-party editors) produce and
 * consume. Lua is the *optional* authoring format — game authors
 * who want dynamic behaviour (string templates, math, loading
 * other files) drop in a `.config.lua` that ends with `return <table>`,
 * and it wins over any adjacent `.config.json`.
 *
 * Because both code paths end up in a LuaParser, the caller reads
 * fields with the usual `LuaTable::GetFloat` / `GetString` / etc.
 * API. The authored Lua can itself call `json.decode(...)` — the
 * `json` global is registered for every LuaParser state via
 * `LuaParser::SetupEnv`, so authors can start from the JSON
 * defaults and layer their own edits on top:
 *
 *     -- tank.config.lua
 *     local defaults = json.decode(VFS.LoadFile("tank.config.json"))
 *     defaults.radius = 60
 *     return defaults
 */
#ifndef LUA_CONFIG_LOADER_H
#define LUA_CONFIG_LOADER_H

#include <memory>
#include <string>

class LuaParser;

namespace LuaConfig {

/// Filename suffixes used by the .config.lua / .config.json
/// convention. Call sites use these to build output paths and
/// check for the existence of either form.
constexpr const char* kLuaSuffix  = ".config.lua";
constexpr const char* kJsonSuffix = ".config.json";

/// Load a config file for the given base path. Tries
/// `<basePath>.config.lua` first, then `<basePath>.config.json`.
///
/// On success returns a `LuaParser` whose root table is the loaded
/// config; the caller reads fields via `result->GetRoot().Get...()`
/// and keeps the unique_ptr alive for as long as they're reading.
/// Returns nullptr if neither file exists or if parsing fails
/// (errors are logged to stderr).
std::unique_ptr<LuaParser> Load(const std::string& basePath);

/// Load only the `.config.json` for the given base path, ignoring
/// any `.config.lua`. Used when the Lua config lacks data (e.g.
/// pieces) that the JSON config provides.
std::unique_ptr<LuaParser> LoadJson(const std::string& basePath);

} // namespace LuaConfig

#endif // LUA_CONFIG_LOADER_H
