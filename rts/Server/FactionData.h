// FactionData — enumerate the factions a game declares in
// gamedata/sidedata.lua (PLAN-metalstorm-lobby.md task 0: faction
// registration).
//
// A bare-lua_State reader in the same spirit as ConfigReader/
// ResourcesParser/AIDiscovery (rts/Server/ConfigReader.h explains why the
// lobby doesn't reuse the sim's rts/Lua/LuaParser). sidedata.lua needs no
// VFS shim — it's a self-contained data file with no VFS.Include calls —
// so this loads it with a plain luaL_loadfile, no sandbox setup.
#pragma once

#include <string>
#include <vector>

namespace FactionData {

/// One declared faction. Mirrors the fields the engine's SideParser
/// (rts/Sim/Misc/SideParser.cpp) reads (`name`, `startUnit`) plus the
/// lobby-only identity fields (`fullName`, `description`) SideParser
/// ignores.
struct FactionInfo {
    /// Stable lookup key — `name` lowercased. Deliberately matches
    /// SideParser's own side-key derivation (StringToLower(name)) so a
    /// value stored in `accounts.faction_id` stays in parity with the
    /// engine's notion of the same side, per the parity note in
    /// sidedata.lua's header comment.
    std::string key;

    /// Short canonical name as declared in sidedata.lua (`name` field;
    /// also what SideParser reads).
    std::string name;

    /// Evocative display name for the sign-up form's faction picker.
    /// Falls back to `name` when the data omits it.
    std::string fullName;

    /// Lore/identity blurb shown on the sign-up form. May be empty.
    std::string description;

    /// Starting unit def id (`startUnit` field). Informational only at
    /// this layer — the lobby doesn't validate it against unit defs.
    std::string startUnit;
};

/// Parse `<gameFolderPath>/gamedata/sidedata.lua` and return its
/// factions in declaration order. A missing file, a file that errors,
/// or one that returns an empty/absent table all yield an empty vector
/// — most games (e.g. papertanks) declare no factions at all, which is
/// a valid, silent state, not an error. Entries missing `name`, and
/// duplicate keys after the second occurrence, are logged and skipped.
std::vector<FactionInfo> Discover(const std::string& gameFolderPath);

} // namespace FactionData
