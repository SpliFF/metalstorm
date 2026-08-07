// ScenarioDiscovery — enumerate the scenario files a game ships under
// `<game>/scenarios/*.lua`, so the lobby can offer them at room-create
// time instead of leaving the choice to a dev-only manifest field.
//
// WHY THIS EXISTS (PLAN-endtoend.md D10). `game_scenario.lua` reads the
// scenario name from the `scenario` modoption. Until this module, the only
// writer of that modoption was the `/api/rooms/direct` manifest path — so a
// war created the way a *player* creates one (the Create Game dialog) staged
// no scenario at all, and therefore had no `victory = true` objective, and
// therefore could never end. The design call recorded in
// PLAN-metalstorm-wars.md §7.1 is: **the scenario is an ordinary room
// setting**, defaulted from the room's map and overridable by the host,
// rather than a hidden property of the boot path.
//
// A scenario already declares the map it is written for (`world.map`), so
// the map→scenario default reads a coupling the *content* already states
// rather than inventing one in the lobby. The lobby surfaces the chosen
// scenario in the room JSON so the coupling is visible, not silent.
//
// Expected shape at `<game>/scenarios/<id>.lua` (PLAN-persistence.md §5,
// the format `game_scenario.lua` loads):
//
//     return {
//         version = 1,
//         name    = 'Meridian Basin — Standard War',
//         tutorial = false,
//         world   = { map = 'meridian_basin', regions = { ... } },
//         objectives = {
//             { type = 'control', ..., victory = true },
//         },
//     }
//
// Like GameDiscovery/AIDiscovery this parses with a bare `lua_State` and
// never touches the sim's Lua API — the lobby binary has no VFS, no
// `Spring.*`, and no sim globals to offer. A scenario that needs any of
// those at file scope will fail to load here and is simply not offered;
// `game_scenario.lua` remains the authority at GameStart.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ScenarioDiscovery {

/// One playable (or NPC) side of a scenario — a `faction` from the scenario's
/// `sides` block, collapsed to the single team a room slot for that side is
/// seated on.
///
/// WHY A SIDE AND NOT A TEAM (PLAN-metalstorm-wars.md §7.4, endtoend D19).
/// A scenario's `sides` block declares many teams per faction (Meridian Basin:
/// compact = 0–3, union = 4–7) but stages a starting force for only one of
/// them (0 and 4). A room slot that picks a bare team index can therefore pick
/// a position with no army — which is exactly what a lobby-created war did:
/// the AI opponent landed on team 1, a declared compact *teammate* the
/// scenario stages nothing for, and the union's whole army was skipped.
/// So the lobby offers sides, and this struct is the resolution.
struct ScenarioSide {
    /// The `faction` key as the scenario writes it (e.g. "compact").
    std::string faction;

    /// The team a room slot for this side is seated on: the lowest of
    /// `teams` that the scenario stages starting `units` for, else the
    /// lowest declared team (with `staged == false`).
    uint8_t team = 0;

    /// Every team the scenario declares for this faction, ascending.
    std::vector<uint8_t> teams;

    /// True when `scenario.units` stages at least one unit for `team`. False
    /// means a slot on this side starts with nothing — the D19 condition,
    /// surfaced rather than discovered at frame 1169.
    bool staged = false;

    /// True when *every* team of this faction is claimed by a `scenario.ai`
    /// entry, i.e. the side is an NPC and must never be offered as a player
    /// slot. Data-driven so Meridian's `reavers` needs no special case.
    bool npc = false;
};

} // namespace ScenarioDiscovery

namespace ScenarioDiscovery {

/// One discovered scenario file.
struct ScenarioInfo {
    /// Stable identifier — the file stem, which is exactly the string
    /// `game_scenario.lua` feeds to `VFS.Include('scenarios/' .. name ..
    /// '.lua')`. This is what goes into the `scenario` modoption.
    std::string id;

    /// Human-readable `name` field. Falls back to `id` when absent.
    std::string displayName;

    /// `world.map` — the map this scenario is authored for. Empty when
    /// the scenario declares none, in which case it is never picked as a
    /// map default (it can still be chosen explicitly).
    std::string mapId;

    /// `tutorial` field. Tutorial scenarios are excluded from the
    /// map-default pick — the tutorial has its own boot path
    /// (`?direct=tutorial`) and is not what a Create Game default should
    /// silently hand a player.
    bool tutorial = false;

    /// `retired` field. A retired war is never defaulted to and never
    /// offered — the lobby treats it as content that exists for fixtures and
    /// for its objective coverage, not as a war a player may pick.
    ///
    /// WHY THIS IS NOT A DELETION (PLAN-metalstorm-wars.md §7.6). The first
    /// scenario to need it, `meridian_basin.lua`, is authored for a map whose
    /// start positions sit in three disconnected components of the passability
    /// mask — its two armies cannot reach each other, so the war ends
    /// uncontested at a deterministic frame however it is paced (endtoend
    /// D20). But it is also the only shipped content exercising `escort` and
    /// `extract` objectives, so the file stays loadable by `game_scenario.lua`
    /// (the `?direct=` manifest path and the gadget specs still stage it) and
    /// only leaves the *offer*. Same shape as `tutorial`: a scenario that is
    /// real and loadable but is not a Create Game choice.
    bool retired = false;

    /// True when any entry in `objectives` carries `victory = true`.
    ///
    /// This is the whole point of the module: `victory` is the ONLY
    /// terminal condition `game_gameover.lua` watches, so a scenario
    /// without one produces a war that cannot end. The lobby prefers
    /// terminal scenarios when defaulting and warns loudly at room start
    /// when the war it is about to spawn has no terminal condition.
    bool terminal = false;

    /// The scenario's `sides` block, grouped by faction and resolved to one
    /// team each (see ScenarioSide). Declaration order is preserved, so the
    /// first entry is the side a room's host is seated on. Empty for a
    /// scenario that declares no sides — callers then fall back to the
    /// legacy two-team room.
    std::vector<ScenarioSide> sides;
};

/// The playable sides of `info` — every entry of `sides` that is not an NPC.
/// This is the list the lobby offers as room slots.
std::vector<ScenarioSide> PlayableSides(const ScenarioInfo& info);

/// Encode `PlayableSides(info)` as the `war_sides` modoption:
/// `"<faction>:<team>[,<faction>:<team>…]"`, e.g. `"compact:0,union:4"`.
///
/// One string, written once by the lobby at room-create time, read by
/// everything downstream: RoomManager parses only the integers out of it
/// (it needs no scenario knowledge), the client renders the labels, and the
/// sim gets it as an ordinary modoption. Returns "" when the scenario
/// declares no playable sides, which every consumer reads as "legacy
/// two-team room" (PLAN-metalstorm-wars.md §7.4).
std::string EncodeWarSides(const ScenarioInfo& info);

/// Scan `<gamePath>/scenarios/` for `*.lua` files and parse each.
/// A missing `scenarios/` directory returns an empty vector — most games
/// ship none, and that is not an error. Results are sorted by `id` so the
/// lobby's dropdown ordering is stable across restarts.
std::vector<ScenarioInfo> Discover(const std::string& gamePath);

/// Pick the scenario to default a room on `mapId` to, or nullptr when the
/// map has no default.
///
/// Rules:
///   1. `world.map` must equal `mapId`.
///   2. Tutorials are never candidates — the tutorial has its own boot path
///      and is not what a Create Game default should silently hand a player.
///   2b. Retired wars are never candidates either, for the stronger reason:
///      the one thing a default must not do is hand a player a war that
///      cannot be fought (PLAN-metalstorm-wars.md §7.6).
///   3. **`terminal` is required, not merely preferred.** The whole purpose
///      of this default is "don't create a war that cannot end", and a
///      non-terminal scenario does not serve it — auto-applying one would
///      stage units and objectives the host never asked for while leaving
///      the war just as endless. A non-terminal scenario stays explicitly
///      selectable; it is only never *automatic*. (Concretely: this is what
///      keeps `scenario_smoke_test` off every dev manifest that boots on
///      green_flat_x34_v3 without naming a scenario.)
///   4. Ties break on lowest `id`, so the pick is deterministic. Callers
///      should log which scenario they applied; `DefaultForMap` is
///      deliberately silent so it stays testable.
///
/// The returned pointer aliases into `scenarios` and is valid only as long
/// as that vector is.
const ScenarioInfo* DefaultForMap(const std::vector<ScenarioInfo>& scenarios,
                                  const std::string& mapId);

/// Find a scenario by its `id`, or nullptr. Used to validate a
/// host-supplied `scenario` before it is written to a modoption, so a
/// typo surfaces in the lobby rather than as a hard `error()` inside
/// `game_scenario.lua` at GameStart.
const ScenarioInfo* FindById(const std::vector<ScenarioInfo>& scenarios,
                             const std::string& id);

} // namespace ScenarioDiscovery
