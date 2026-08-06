// FactionData — enumerate the factions a game declares in
// gamedata/sidedata.lua (PLAN-metalstorm-lobby.md task 0: faction
// registration).
//
// A bare-lua_State reader in the same spirit as ConfigReader/
// ResourcesParser/AIDiscovery (rts/Server/ConfigReader.h explains why the
// lobby doesn't reuse the sim's rts/Lua/LuaParser).
//
// sidedata.lua DOES need a VFS shim. An earlier revision of this comment
// claimed the opposite ("a self-contained data file with no VFS.Include
// calls") and justified a plain luaL_loadfile with it; that was wrong for
// real game data. BAR's opens with
//   local SIDES = VFS.Include("gamedata/sides_enum.lua")
//   if not SIDES then error("[Sidedata] Failed to load sides_enum.lua!") end
// which raised `attempt to index a nil value (global 'VFS')` on every lobby
// boot and made /api/factions/bar return [] instead of BAR's four real
// sides. So Discover installs the same minimal `VFS.Include` shim
// ConfigReader uses for legacy-game wrappers, resolved relative to the game
// folder. Nothing else from the sim's VFS is provided — a sidedata.lua that
// reaches for more still fails safe (empty vector + one warning).
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

    /// Starting unit def id. Informational only at this layer — the lobby
    /// doesn't validate it against unit defs. Read from `startUnit` and,
    /// failing that, `startunit`: the sim reads this through LuaTable,
    /// which lowercases keys, so both spellings are live in shipped data
    /// (Metalstorm uses `startUnit`, BAR and ZK use `startunit`).
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
