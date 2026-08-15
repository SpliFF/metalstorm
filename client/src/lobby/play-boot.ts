/**
 * `?play=<scenarioId>` boot helpers — pure, no DOM and no fetch.
 *
 * The `?play=` URL goes from a cold browser to a running scenario with no
 * login screen and no lobby UI: main.ts's `bootPlay` runs an auth ladder
 * (stored session → guest resume → guest mint → only then login) and POSTs
 * the manifest these helpers build.
 *
 * This file is the browser twin of `tools/debug-mcp/scenario-manifest.js`.
 * The two build worlds cannot share a module, so the derivation lives twice
 * and `play-boot.test.ts`'s parity fixture is what keeps them identical.
 *
 * The founding trap: `scenario` is the TOP-LEVEL manifest field. The lobby
 * applies `modoptions` first and then routes the top-level field through
 * `applyRoomScenario`, which overwrites the `scenario` modoption — with the
 * map's default when no top-level field is present. `modoptions.scenario`
 * alone is silently discarded.
 */

export interface ScenarioSide {
    faction: string;
    team: number;
    staged?: boolean;
}

export interface ScenarioInfo {
    id: string;
    displayName?: string;
    map?: string;
    sides?: ScenarioSide[];
    tutorial?: boolean;
    retired?: boolean;
    terminal?: boolean;
}

export interface PlayParams {
    scenarioId: string;
    gameId: string;
    /** Attach mode: the room the MCP already launched. */
    room?: number;
    user?: string;
    /** Direct-minted session token, carried in the URL *hash* only. */
    token?: string;
    side?: string;
    ai?: string;
    map?: string;
    skipBriefing: boolean;
}

export interface PlayManifest {
    name: string;
    game: string;
    map: string;
    scenario: string;
    players: { username: string; team?: number; spectator?: boolean }[];
    aiSlots: { aiId: string; team: number }[];
    modoptions: Record<string, string>;
    autoStart: boolean;
}

/// The browser default is a real opponent — a human opening a play link
/// wants a game. (The MCP defaults to 'null' instead, for determinism.)
export const DEFAULT_PLAY_AI = 'strategos';

/// Parse `?play=…` params. The token comes from the hash fragment, never the
/// query string: fragments are not sent to the server, so the session token
/// stays out of the lobby access log and the Vite log.
export function parsePlayParams(search: string, hash: string): PlayParams | null {
    const q = new URLSearchParams(search.replace(/^\?/, ''));
    const scenarioId = q.get('play');
    if (!scenarioId) return null;
    const h = new URLSearchParams(hash.replace(/^#/, ''));
    const roomRaw = q.get('room');
    const room = roomRaw !== null && roomRaw !== '' ? Number(roomRaw) : undefined;
    return {
        scenarioId,
        gameId: q.get('game') || 'metalstorm',
        room: Number.isFinite(room) ? room : undefined,
        user: q.get('user') || undefined,
        token: h.get('token') || undefined,
        side: q.get('side') || undefined,
        // `?ai=` present but empty means "no AI slots" — distinct from absent.
        ai: q.get('ai') ?? undefined,
        map: q.get('map') || undefined,
        skipBriefing: q.get('skipBriefing') === '1',
    };
}

/// Host team + AI slots from a scenario's playable sides. Mirrors
/// `derivePlaySlots` in tools/debug-mcp/scenario-manifest.js.
export function derivePlaySlots(
    sides: ScenarioSide[] | undefined | null,
    sideParam?: string,
    ai: string = DEFAULT_PLAY_AI,
): { hostTeam: number; aiSlots: { aiId: string; team: number }[] } {
    const playable = Array.isArray(sides) ? sides : [];
    if (!playable.length) {
        // Sideless scenario: legacy two-team shape, same as launch_game.
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

/// Build the `/api/rooms/direct` manifest for a fresh `?play=` boot.
///
/// Room name is `play:<scenarioId>:<username>` — scoped per user so two
/// browsers on one dev lobby do not tear each other's games down, and per
/// scenario so re-opening the same link replaces your own stale room
/// instead of leaking rooms.
export function buildPlayManifest(
    scenario: ScenarioInfo,
    username: string,
    params: PlayParams,
): PlayManifest {
    const map = params.map || scenario.map || '';
    if (!map) throw new Error(`scenario "${scenario.id}" declares no map — pass &map=<mapId>.`);
    const ai = params.ai === undefined ? DEFAULT_PLAY_AI : params.ai;
    const { hostTeam, aiSlots } = derivePlaySlots(scenario.sides, params.side, ai);
    return {
        name: playRoomName(params.scenarioId, username),
        game: params.gameId,
        map,
        scenario: params.scenarioId,
        players: [{ username, team: hostTeam }],
        aiSlots,
        modoptions: {},
        autoStart: true,
    };
}

export function playRoomName(scenarioId: string, username: string): string {
    return `play:${scenarioId}:${username}`;
}

/// Attach mode's players[] lookup: which player row in the room JSON is us.
export function pickAttachIdentity(roomJson: any, user: string): { playerId: number } | null {
    const players = roomJson?.players;
    if (!Array.isArray(players)) return null;
    const row = players.find((p: any) => p?.username === user);
    if (!row || typeof row.player_id !== 'number') return null;
    return { playerId: row.player_id };
}

/// Room states: 5 = Ended. An ended room cannot be attached to — the caller
/// falls through to a fresh launch so a play link never dangles.
export function isAttachableRoom(roomJson: any): boolean {
    return !!roomJson && roomJson.state !== 5;
}
