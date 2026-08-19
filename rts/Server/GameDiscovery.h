// GameDiscovery — enumerate game plugins under the games directory.
//
// A "game" is a folder that contains (at minimum) a `modinfo.lua`
// file following Spring's standard shape:
//
//     return {
//         name        = 'Paper Tanks',
//         shortName   = 'papertanks',
//         description = '…',
//         version     = '0.1',
//         ...
//     }
//
// We parse it with the same lightweight regex approach used by
// AIDiscovery — no Lua VM in the lobby binary — which is safe for
// the small handful of string fields the lobby cares about. Authors
// who want rich behaviour still have the real Lua interpreter at
// game-server startup; this discovery path exists only to populate
// the room browser's "create game" UI.
//
// Discovery happens once at lobby startup. Each `GameInfo` holds
// the filesystem path to the game folder, which is what the lobby
// hands to `spawnGameServer` when the host starts the room.
#pragma once

#include <string>
#include <vector>

namespace GameDiscovery {

/// One discovered game plugin.
struct GameInfo {
    /// Stable identifier — derived from the folder name, lowercased.
    /// Matches `shortName` in modinfo.lua by convention but we trust
    /// the folder name for uniqueness (authors might ship a modinfo
    /// with a stale shortName after renaming their directory).
    std::string id;

    /// Human-readable name from modinfo.lua's `name` field. Falls
    /// back to the folder name if the field is missing or empty.
    std::string displayName;

    /// Short name from modinfo.lua's `shortName`/`shortname` field
    /// (e.g. "ZK", "BYAR"). Surfaced as `Game.modShortName` to widgets.
    /// Falls back to the uppercased `id` when the field is missing.
    std::string shortName;

    /// Optional description from modinfo.lua's `description` field.
    /// May be empty.
    std::string description;

    /// Optional version string from modinfo.lua's `version` field.
    /// May be empty.
    std::string version;

    /// Lighting style the game wants the client renderer to use. Read
    /// from modinfo.lua's `lighting` field; defaults to `"gameplay"`.
    /// Recognised values:
    ///   - `"gameplay"`  half-Lambert + flat ambient floor. Tuned so
    ///                    tall, thin units (radar masts, the Lotus
    ///                    turret spire) keep readable silhouettes at
    ///                    typical RTS camera distance. Side faces sit
    ///                    around 45% brightness even when no sun hits.
    ///   - `"realistic"` true Lambert + lower ambient + sky-tinted
    ///                    upward bias. Strong front/back contrast on
    ///                    units; closer to a third-party glTF viewer's
    ///                    interpretation of the same model. Trades the
    ///                    distance-readability for close-up shape.
    /// Surfaced verbatim in the `/api/games` JSON; entity-renderer
    /// converts it to a `#define` at material-compile time.
    std::string lighting;

    /// Identifies which game-specific model-material *port* the client
    /// should apply, read from modinfo.lua's `modelMaterialPort` field
    /// (PLAN-bar.md A4). Empty ⇒ the engine-default model material.
    ///
    /// The client ships hand-ports of specific games' GL3 CUS material
    /// templates (e.g. `zk-model-material.ts` reproduces Zero-K's
    /// `defaultMaterialTemplate.lua`). Each port targets one template
    /// identity; the client applies its port only when this flag matches
    /// the id the port reproduces (e.g. `"zk-939"` for ZK's 939-line
    /// template), otherwise it falls back to the engine-default material.
    /// BAR ships a different (GL4) template we can't render on WebGL2, so
    /// it omits the flag and correctly gets the engine-default look.
    ///
    /// ACCEPTED LIMITATION (per the 2026-06-11 design call, simple flag
    /// not a content hash): this does NOT detect the live template
    /// drifting away from the hand-port — the client port must carry a
    /// comment naming the exact template version/line-count it
    /// reproduces. Surfaced verbatim in `/api/games`.
    std::string modelMaterialPort;

    /// True when the game is kept on disk but cannot be played
    /// (PLAN-endtoend.md D26). Read from the game config's `archived`
    /// field; defaults false, so a game says nothing and stays playable.
    ///
    /// Discovery deliberately still RETURNS an archived game. The folder
    /// is real, `/api/rooms/direct` still stages it from a manifest for
    /// fixtures and crash repros, and dropping it here would make the
    /// lobby disagree with the filesystem. What changes is who may pick
    /// it: `/api/games` surfaces the flag, the create-room picker renders
    /// the option disabled with `archivedReason`, and `POST /api/rooms`
    /// refuses it — the same shape as ScenarioDiscovery's `retired`.
    bool archived = false;

    /// One sentence on why, shown to the player on the disabled option.
    /// Empty when `archived` is false.
    std::string archivedReason;

    /// True when the game is played with the engine's metal/energy
    /// resource economy (PLAN-endtoend.md D9). Read from the game config's
    /// `resourceEconomy` field; **defaults true**, because every legacy
    /// Spring game has one and silence must not blank a surface that game
    /// depends on.
    ///
    /// Metalstorm declares it false: authority replaces metal and energy
    /// there, so the client's `#economy-bar` sat at the top of the screen
    /// reading `M 0 / 1000k  E 0 / 1000k` for the whole match. The server
    /// still streams `ResourceUpdate` for every game (the sim has the
    /// counters either way) — this flag is what tells the client that
    /// rendering them is meaningless, and it lives in the game's own data
    /// rather than as a game-id test in the client, the same call
    /// `archived` above made.
    bool resourceEconomy = true;

    /// Absolute path to the game folder on disk (e.g. "data/games/papertanks").
    /// Used for content loading and AI discovery.
    std::string folderPath;
};

/// Scan `gamesDir` (default: data/games) for subdirectories
/// containing a `modinfo.lua`, parse each, and return a sorted
/// vector of `GameInfo`. Missing `gamesDir` returns an empty
/// vector — the lobby will still run, it just has no games to
/// offer until one is added.
std::vector<GameInfo> Discover(const std::string& gamesDir);

/// Look one game up by id. Returns nullptr when it isn't there.
const GameInfo* FindById(const std::vector<GameInfo>& games,
                         const std::string& id);

/// The game a create request gets when it names none — the first
/// PLAYABLE one in discovery order, or nullptr when every discovered
/// game is archived.
///
/// The old rule here was `games[0]`, which is alphabetical and therefore
/// picked `bar` on this tree: the server's own fallback default was a
/// game it would now refuse (PLAN-endtoend.md D26). Returning nullptr
/// rather than falling back to an archived game is deliberate — a
/// caller that cannot name a playable game should say so, not stage a
/// room that cannot start.
const GameInfo* DefaultPlayable(const std::vector<GameInfo>& games);

} // namespace GameDiscovery
