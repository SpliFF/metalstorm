/**
 * entry-flow.ts — the decisions behind welcome → intro → hub
 * (PLAN-beta-journey.md §(e)). Pure: LobbyUI keeps the DOM and the fetches.
 */

/// `POST /api/account/me` (A1). Null when the route is absent — a lobby built
/// before journey-accounts landed — and every decision below must still land
/// somewhere sensible.
export interface AccountMe {
    user_id: number;
    username: string;
    callsign: string;
    faction: string | null;
    is_provisional: boolean;
    standing: number;
    sessions_played: number;
    tier: number;
    tier_name: string;
    commander_kind: string | null;
    /// A1 serialises this as a JSON boolean; the plan said 0/1. Both are read.
    intro_done: number | boolean;
}

export type EntryScreen = 'intro' | 'hub' | 'browser';

export interface EntryContext {
    me: AccountMe | null;
    /// This sign-in created the account (register or a guest upgrade).
    justRegistered: boolean;
    /// The browser already walked this account through the intro — the
    /// stand-in for `intro_done` while `me` is null.
    introSeenLocally: boolean;
    /// "Watch as <callsign>": straight to the Mission list, Watch first.
    watch: boolean;
}

/// Where a sign-in lands. Unknown standing is treated as Recruit: the hub is
/// the screen that explains the game, the browser is the one that assumes
/// you know it, and a wrong guess in that direction costs one click.
export function decideEntry(ctx: EntryContext): EntryScreen {
    if (ctx.watch) return 'browser';
    if (ctx.me) {
        if (!ctx.me.intro_done && !ctx.me.is_provisional) return 'intro';
        return ctx.me.tier >= 1 ? 'browser' : 'hub';
    }
    if (ctx.justRegistered && !ctx.introSeenLocally) return 'intro';
    return 'hub';
}

/// `?play=` boot: the public solo route for players, the dev direct route on
/// the lobby host (where `/api/rooms/direct` is allowed by LocalhostOrAdmin).
export function soloBootRoute(hostname: string): 'solo' | 'direct' {
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return 'direct';
    return 'solo';
}

/// The four cosmetic commander kinds (`users.commander_kind`). Icon only at
/// beta — no per-kind art, nothing mechanical.
export const COMMANDER_KINDS: { key: string; name: string; blurb: string; glyph: string }[] = [
    { key: 'surveyor', name: 'Surveyor', glyph: '◬', blurb: 'Reads the ground first. Recon, routes, the long view.' },
    { key: 'foundry',  name: 'Foundry',  glyph: '⬢', blurb: 'Keeps the line supplied. Engineers, works, repair.' },
    { key: 'line',     name: 'Line',     glyph: '▲', blurb: 'Holds and takes ground. Armour and infantry, forward.' },
    { key: 'signals',  name: 'Signals',  glyph: '◈', blurb: 'Sees and says. Radar, coordination, the team net.' },
];

export const INTRO_SEEN_KEY = 'springrts-intro-seen';

/// The tier label the hub header shows. Falls back to Recruit when `me` is
/// unknown, for the reason `decideEntry` does.
export function tierLabel(me: AccountMe | null): string {
    if (!me) return 'Recruit';
    return me.tier_name || 'Recruit';
}

/// What the welcome screen says after a Watch-as sign-in that did not get the
/// callsign it asked for (a lobby without A1: the name is ignored and a
/// `guest-<hex>` comes back). Empty when the name was honoured.
export function nicknameNote(requested: string, granted: string | undefined): string {
    if (!requested || !granted || granted === requested) return '';
    return `This server does not take callsigns yet — you are watching as ${granted}.`;
}
