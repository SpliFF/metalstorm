/**
 * Pure `/api/rooms/direct` manifest builder for scenario launches.
 *
 * No I/O, no MCP types — everything here is a function of
 * (scenario metadata, host identity, caller overrides), so it is testable
 * on its own and mirrors `client/src/lobby/play-boot.ts` exactly. The two
 * files intentionally duplicate the derivation (Node and the browser build
 * cannot share a module across this repo's two build worlds); the parity
 * fixture in `client/src/lobby/play-boot.test.ts` is what stops them from
 * drifting. Change one, change the other, and re-run that test.
 *
 * The founding trap: `scenario` MUST be the TOP-LEVEL manifest field. The
 * lobby applies the manifest's `modoptions` first and *then* routes the
 * top-level field through `applyRoomScenario` (lobby_main.cpp:3958-3961),
 * which overwrites the `scenario` modoption — with the map's default when
 * the manifest carries no top-level value. A `modoptions.scenario` alone is
 * therefore silently discarded.
 */

/// Derive the host's team and the AI slots from a scenario's playable sides.
///
///   sides    — `[{faction, team, staged}]` from GET /api/games/<id>/scenarios
///              (NPC sides are already filtered out by the route). `[]` or
///              null selects the legacy two-team shape (host 0, AI on 1).
///   sideParam— optional playable faction key to seat the host on.
///   ai       — AI id for every non-host playable side; '' means no AI slots.
///
/// Throws with the valid faction list when `sideParam` names no playable side.
export function derivePlaySlots(sides, sideParam, ai) {
    const playable = Array.isArray(sides) ? sides : [];
    if (!playable.length) {
        // Legacy/sideless scenario (e.g. scenario_smoke_test, tutorial_01):
        // mirror launch_game's shape rather than inventing seats.
        return { hostTeam: 0, aiSlots: ai === '' ? [] : [{ aiId: ai, team: 1 }] };
    }
    let host = playable[0];
    if (sideParam) {
        const found = playable.find((s) => s.faction === sideParam);
        if (!found) {
            throw new Error(
                `side "${sideParam}" is not a playable side of this scenario. `
                + `Valid: ${playable.map((s) => s.faction).join(', ')}.`);
        }
        host = found;
    }
    const aiSlots = ai === '' ? [] : playable
        .filter((s) => s !== host)
        .map((s) => ({ aiId: ai, team: s.team }));
    return { hostTeam: host.team, aiSlots };
}

/// Build the direct-start manifest.
///
///   scenario        — the route's scenario JSON, or null under `force`.
///   scenarioId      — required; the top-level manifest field.
///   gameId, mapId   — mapId defaults to `scenario.map`; one of them must exist.
///   players         — `[{username, team?, side?, spectator?}]`; players[0] is
///                     the room host and defaults to the host side's team.
///   side, ai        — see derivePlaySlots.
///   modoptions      — caller extras; a `scenario` key here is hoisted out.
///   roomName        — required (callers own the naming convention).
///   idleGraceSeconds— written as `idleStartupGraceSeconds` (inert until P3).
///
/// Returns `{ manifest, notes }`; throws Error with a caller-facing message.
export function buildScenarioManifest(opts) {
    const {
        scenario = null, scenarioId, gameId = 'metalstorm', mapId,
        players, side, ai = 'null', modoptions, roomName, idleGraceSeconds,
    } = opts;
    const notes = [];

    if (!scenarioId) throw new Error('scenarioId is required.');
    if (!roomName) throw new Error('roomName is required.');
    const map = mapId || scenario?.map || '';
    if (!map) {
        throw new Error(
            `no map: scenario "${scenarioId}" declares none in the lobby's list `
            + '(or was not resolved, under force:true) — pass mapId.');
    }

    const { hostTeam, aiSlots } = derivePlaySlots(scenario?.sides, side, ai);

    const roster = (players && players.length) ? players : [{ username: 'admin' }];
    const playable = scenario?.sides ?? [];
    const manifestPlayers = roster.map((p, i) => {
        if (!p || !p.username) throw new Error(`players[${i}] needs a username.`);
        const row = { username: p.username };
        if (typeof p.team === 'number') {
            row.team = p.team;
        } else if (p.side) {
            const found = playable.find((s) => s.faction === p.side);
            if (!found) {
                throw new Error(
                    `players[${i}].side "${p.side}" is not a playable side. `
                    + `Valid: ${playable.map((s) => s.faction).join(', ') || '(none — pass team)'}.`);
            }
            row.team = found.team;
        } else if (i === 0) {
            row.team = hostTeam;
        } else {
            row.spectator = true;
        }
        if (p.spectator) { row.spectator = true; delete row.team; }
        return row;
    });

    // modoptions hygiene: a `scenario` key here would be overwritten by the
    // map default, so hoist it and say so rather than losing it silently.
    const extra = { ...(modoptions || {}) };
    if ('scenario' in extra) {
        const hoisted = String(extra.scenario);
        delete extra.scenario;
        notes.push(hoisted === scenarioId
            ? 'modoptions.scenario was dropped — `scenario` only works as the top-level manifest field.'
            : `modoptions.scenario "${hoisted}" was dropped in favour of the top-level scenario "${scenarioId}" `
              + '(a scenario modoption is overwritten by the map default).');
    }

    const manifest = {
        name: roomName,
        game: gameId,
        map,
        scenario: scenarioId,
        players: manifestPlayers,
        aiSlots: aiSlots.map((s) => ({ aiId: s.aiId, team: s.team })),
        modoptions: extra,
        autoStart: true,
    };
    if (typeof idleGraceSeconds === 'number') {
        manifest.idleStartupGraceSeconds = idleGraceSeconds;
    }
    return { manifest, notes };
}
