// scenario-picker — the Create Game dialog's War row, and the room screen's
// "War:" label, as pure functions over the list `GET /api/games/<id>/scenarios`
// returns.
//
// WHY THIS IS A MODULE AND NOT METHODS ON LobbyUI. Same reason war-sides.ts is
// (PLAN-metalstorm-wars.md §7.4): every decision here is a rule that has to
// mirror a server-side rule exactly, and a rule you cannot test is a rule that
// drifts. `defaultScenarioFor` in particular mirrors
// `ScenarioDiscovery::DefaultForMap` — including its deliberate refusal to
// auto-apply a non-terminal scenario — and the client has no other way to
// predict what the server will pick when the create request omits `scenario`.
//
// GENERATED SCENARIOS ARE NOT A SEPARATE CASE. Procedurally generated wars
// (tools/mapgen/scenariogen.py, stored in `generated_scenarios` and
// materialised to `scenarios/gen_<id>.lua`) arrive through the same endpoint as
// shipped ones, because the server materialises them into the directory
// `ScenarioDiscovery::Discover` scans before it scans it. Nothing in this file
// knows the difference, and that is the requirement — a generated war has to be
// selectable in the picker exactly like an authored one.

/// One entry from `GET /api/games/<id>/scenarios` — a war template, either
/// shipped under `scenarios/<id>.lua` or generated and materialised there.
export interface AvailableScenarioInfo {
    /// The `scenario` modoption value; what game_scenario.lua VFS.Includes.
    /// Generated scenarios carry a `gen_` prefix, but no consumer keys on it.
    id: string;
    displayName: string;
    /// The scenario's `world.map`. Used to filter the picker down to the
    /// map being created on, and to pick the default.
    map: string;
    /// Tutorial scenarios have their own boot path and are never offered
    /// as a plain create-room choice.
    tutorial: boolean;
    /// Whether the scenario declares a `victory = true` objective. False
    /// means the war has no terminal condition and cannot end — surfaced
    /// in the picker rather than discovered 40 minutes in.
    terminal: boolean;
}

/// Normalise the endpoint's JSON. Tolerant by design: a missing field must
/// degrade the entry, never drop the list. `terminal` defaults to FALSE on a
/// malformed entry, which is the safe direction — it produces a visible "no
/// ending" warning rather than silently promising an ending that isn't there.
export function parseScenarioList(raw: unknown): AvailableScenarioInfo[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
        .map(s => ({
            id: typeof s.id === 'string' ? s.id : '',
            displayName: typeof s.displayName === 'string' && s.displayName
                ? s.displayName
                : (typeof s.id === 'string' ? s.id : ''),
            map: typeof s.map === 'string' ? s.map : '',
            tutorial: !!s.tutorial,
            terminal: !!s.terminal,
        }))
        .filter(s => s.id !== '');
}

/// Which scenarios are offerable for `mapId`.
///
/// Tutorials are excluded (they have their own boot path), and so are
/// scenarios authored for a different map — a scenario's region keys only make
/// sense against its own map's region graph, so offering a cross-map pairing
/// would stage a broken war.
export function scenariosForMap(
    list: readonly AvailableScenarioInfo[], mapId: string,
): AvailableScenarioInfo[] {
    if (!mapId) return [];
    return list.filter(s => !s.tutorial && s.map === mapId);
}

/// The scenario the SERVER will apply when the create request omits
/// `scenario`, or null when it will apply none.
///
/// Mirrors ScenarioDiscovery::DefaultForMap: terminal is REQUIRED, not
/// preferred, and ties break on the lowest id so the pick is deterministic.
/// When a map's only wars are endless the honest default is "no war", not one
/// of them — auto-applying a non-terminal scenario would stage units and
/// objectives the host never asked for while leaving the war just as endless.
export function defaultScenarioFor(
    offerable: readonly AvailableScenarioInfo[],
): AvailableScenarioInfo | null {
    let best: AvailableScenarioInfo | null = null;
    for (const s of offerable) {
        if (!s.terminal) continue;
        if (best === null || s.id < best.id) best = s;
    }
    return best;
}

/// The `<option>` text for one scenario.
///
/// A war that cannot end is marked; one that can is not. The asymmetry is
/// deliberate — "no ending" is the surprising property and the one worth
/// spending the player's attention on, whereas badging every ordinary war
/// would make the marking invisible by repetition.
export function scenarioOptionLabel(s: AvailableScenarioInfo): string {
    return s.terminal ? s.displayName : `${s.displayName} — no ending`;
}

/// The note under the picker for whatever is currently selected. `picked` is
/// null when no war will be staged at all.
export function scenarioNote(
    picked: AvailableScenarioInfo | null,
): { className: string; text: string } {
    if (!picked) {
        return {
            className: 'scenario-note endless',
            text: 'No war will be staged, so this battle has no ending. '
                + 'Leave by detaching.',
        };
    }
    if (!picked.terminal) {
        return {
            className: 'scenario-note endless',
            text: 'This war declares no victory objective — it has no ending. '
                + 'Leave by detaching.',
        };
    }
    return {
        className: 'scenario-note',
        text: `Ends when the war's victory objective is completed.`,
    };
}

/// Resolve a room's `scenario` modoption to something to show on the room
/// screen.
///
/// The room screen reads the SAME list the picker is built from, so a
/// generated scenario has to resolve here too — otherwise a room created with
/// one shows a raw `gen_<map>_<hash>` id where every other room shows a name.
///
/// `known` is false for an id absent from the list. The caller must not claim
/// "no ending" in that case: an unrecognised id means we have no list (the
/// fetch failed, or it is for another game), not that the war is endless.
export function resolveScenarioLabel(
    list: readonly AvailableScenarioInfo[], scenarioId: string,
): { label: string; known: boolean; terminal: boolean } {
    const info = list.find(s => s.id === scenarioId);
    return info
        ? { label: info.displayName, known: true, terminal: info.terminal }
        : { label: scenarioId, known: false, terminal: false };
}
