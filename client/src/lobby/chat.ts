/**
 * Chat — the client half of task 9b (PLAN-lobby.md §3).
 *
 * The service landed first (`rts/Server/Chat.{h,cpp}`, `SSETickets.h`, the six
 * `/api/chat/*` routes): six scopes, a canonical `(scope, target)` per
 * conversation, ignore enforced on delivery, and an identified SSE channel a
 * ticket lets an `EventSource` subscribe to. This file is everything the panel
 * decides, kept away from the DOM for the reason `friends.ts` is — the
 * interesting rules here are about identity and absence, and those are worth
 * asserting rather than eyeballing.
 *
 * Three rules the server's shape forces on the client, each of which is a
 * silent defect when it is not stated:
 *
 *  1. **A conversation is keyed by the SERVER'S target, and the target you
 *     POST is not always the target you receive.** For a PM the client sends
 *     `target: "<username>"` (the route resolves the account) and every frame
 *     comes back as `target: "<lo>:<hi>"` (Chat::PmTarget, order-independent).
 *     A tab keyed on what the player typed therefore never matches its own
 *     replies, and the same conversation opens twice the moment the other
 *     party answers. So a tab carries BOTH: `target` matches frames, and
 *     `sendTarget` is what the routes want back.
 *  2. **A room-shaped scope's target is derived, not chosen.** `room`, `ally`
 *     and `spectator` all POST the room id and come back as `<id>`,
 *     `<id>/ally/<team>` and `<id>/spec`. The client must never build the ally
 *     target itself — the server takes the team off the roster precisely so a
 *     client cannot name one — but it must know the shape to route the frame.
 *  3. **A room tab dies with the room.** Leaving takes the membership with it
 *     and every later `send`/`history` on that scope is a 403, so a tab left
 *     behind is a surface that answers nothing. `syncRoomTabs` is the only
 *     thing that creates or removes them.
 */

/// `ChatScopeToString` (Chat.cpp), verbatim.
export type ChatScopeKey = 'main' | 'channel' | 'room' | 'ally' | 'spectator' | 'pm';

/// One line, in the shape both the SSE frame and `/api/chat/history` use.
/// `scope`/`target` are absent from a history row (the reply names them once
/// for the whole page), so they are filled in by `applyHistory`.
export interface ChatFrame {
    id: number;
    scope: ChatScopeKey;
    target: string;
    from: string;
    fromId: number;
    text: string;
    ts: number;
    /// Set on lines the server wrote (joins, leaves, game start) rather than a
    /// player. Rendered without a name.
    system?: boolean;
}

/// What the panel shows one tab of.
export interface ChatTab {
    /// `${scope}:${target}` — built from the canonical target, so two clients
    /// looking at one conversation agree on the key.
    key: string;
    scope: ChatScopeKey;
    /// Canonical target as the server publishes it. Matches incoming frames.
    target: string;
    /// What `/api/chat/{send,history}` want in their `target` field. Equal to
    /// `target` for every scope except `pm` (a username) and the three
    /// room-shaped ones (the bare room id).
    sendTarget: string;
    label: string;
    /// Can the player close it? `#main` cannot (§3.1 makes it default-joined
    /// and the server refuses to leave it), and neither can a room tab — that
    /// one follows the room.
    closable: boolean;
    messages: ChatFrame[];
    unread: number;
    /// Has the backfill run? A tab that has never been opened has not asked
    /// for history, and asking again on every click would re-page it.
    loaded: boolean;
}

/// How many lines a tab keeps in memory. The store is authoritative and
/// `history` pages backwards, so this is a render budget, not a retention
/// policy.
export const CHAT_TAB_LIMIT = 300;

/// `kSSETicketTtlSec` (SSETickets.h). Mirrored rather than fetched because the
/// ticket route reports it (`ttl`) and the client uses the reply when it has
/// one — this is the value it assumes before the first mint answers.
export const CHAT_TICKET_TTL_SEC = 15 * 60;

export function tabKey(scope: ChatScopeKey, target: string): string {
    return `${scope}:${target}`;
}

/// `Chat::PmTarget` — the two ids, low first. Order-independent on purpose:
/// both ends of a PM must name one conversation.
export function pmTarget(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/// The other account in a PM target, or 0 if it is not one (or not mine).
export function pmOther(target: string, myId: number): number {
    const parts = target.split(':');
    if (parts.length !== 2) return 0;
    const a = Number(parts[0]), b = Number(parts[1]);
    if (!a || !b) return 0;
    if (a === myId) return b;
    if (b === myId) return a;
    return 0;
}

/// `Chat::NormalizeChannel` — lower case, `[a-z0-9_-]`, 1..24, `#` stripped.
/// Mirrored so the client can key a tab before the server answers; anything
/// this refuses the server refuses too.
export function normalizeChannel(name: string): string {
    const s = name.trim().replace(/^#/, '').toLowerCase();
    if (!/^[a-z0-9_-]{1,24}$/.test(s)) return '';
    return s;
}

/// The seat this account holds in the room the client is standing in, which is
/// what decides which room-shaped tabs exist. `team` is only meaningful for a
/// player — the server refuses ally chat to a spectator because a spectator's
/// `team` is a leftover value rather than a seat.
export interface RoomSeat {
    roomId: number;
    team: number;
    isSpectator: boolean;
}

/// What one `/api/chat/send` needs, or what a slash command did instead.
export type ChatCommand =
    | { kind: 'send'; scope: ChatScopeKey; target: string; text: string }
    | { kind: 'pm'; username: string; text: string }
    | { kind: 'ignore'; username: string; on: boolean }
    | { kind: 'channel'; channel: string; join: boolean }
    /// `scope`/`target` absent = the account-level mute (`/gmute`), which
    /// belongs to no conversation; present = this one conversation.
    | { kind: 'mute'; username: string; scope?: ChatScopeKey; target?: string;
        seconds: number; reason: string; on: boolean }
    | { kind: 'kick'; channel: string; username: string; seconds: number; reason: string }
    | { kind: 'broadcast'; text: string }
    | { kind: 'mutes' }
    | { kind: 'error'; message: string }
    | { kind: 'none' };

/// `<n>[s|m|h|d]` → seconds; `perm`/`forever` → 0, which the service reads as
/// *until lifted* (`until = 0`; the ROW is the mute, so its absence is the
/// only "not muted"). -1 means "that was not a duration", which is how an
/// optional duration is told apart from the first word of a reason.
export function parseChatDuration(word: string): number {
    const w = word.trim().toLowerCase();
    if (!w) return -1;
    if (w === 'perm' || w === 'permanent' || w === 'forever') return 0;
    const m = /^(\d+)([smhd]?)$/.exec(w);
    if (!m) return -1;
    const n = Number(m[1]);
    switch (m[2]) {
        case 'd': return n * 86400;
        case 'h': return n * 3600;
        case 'm': return n * 60;
        default: return n;   // bare number and `s` are both seconds
    }
}

/// Parse what the player typed in the composer.
///
/// §3.4 asks for `/me`, `/w user` and `/ignore` client-side. Two of the three
/// are routes; `/me` is not, and there is no `action` flag on the wire — so it
/// is sent as ordinary text with its marker intact and every client renders
/// the marker (`isActionLine` below). That is a deviation from the protocol
/// sketch's `flags` field and is deliberate: an action line that depends on a
/// server column would be invisible to the clients that did not ask for it,
/// whereas the marker survives history, replay and a client that never heard
/// of `/me`.
export function parseChatInput(raw: string, active: ChatTab | null): ChatCommand {
    const text = raw.trim();
    if (!text) return { kind: 'none' };
    if (!text.startsWith('/')) {
        if (!active) return { kind: 'error', message: 'No channel selected.' };
        return { kind: 'send', scope: active.scope, target: active.sendTarget, text };
    }

    const sp = text.indexOf(' ');
    const word = (sp === -1 ? text : text.slice(0, sp)).slice(1).toLowerCase();
    const rest = sp === -1 ? '' : text.slice(sp + 1).trim();

    switch (word) {
        case 'me': {
            if (!rest) return { kind: 'error', message: 'Usage: /me <what you are doing>' };
            if (!active) return { kind: 'error', message: 'No channel selected.' };
            return { kind: 'send', scope: active.scope, target: active.sendTarget,
                     text: `/me ${rest}` };
        }
        case 'w':
        case 'msg':
        case 'pm': {
            const gap = rest.indexOf(' ');
            const who = gap === -1 ? rest : rest.slice(0, gap);
            const body = gap === -1 ? '' : rest.slice(gap + 1).trim();
            if (!who) return { kind: 'error', message: 'Usage: /w <player> <message>' };
            return { kind: 'pm', username: who, text: body };
        }
        case 'ignore':
        case 'unignore': {
            if (!rest) return { kind: 'error', message: `Usage: /${word} <player>` };
            return { kind: 'ignore', username: rest.split(' ')[0], on: word === 'ignore' };
        }
        case 'join':
        case 'leave': {
            // The WHOLE argument has to be one channel name. Taking the first
            // word instead would answer `/join #not a channel` by joining
            // `#not` — a channel the player never asked for, reported as a
            // success.
            const chan = normalizeChannel(rest);
            if (!chan) {
                return { kind: 'error',
                         message: `Usage: /${word} #channel (letters, digits, - and _)` };
            }
            return { kind: 'channel', channel: chan, join: word === 'join' };
        }
        case 'mute':
        case 'unmute':
        case 'gmute':
        case 'gunmute': {
            const global = word.startsWith('g');
            const on = !word.includes('un');
            const [who, ...tail] = rest.split(/\s+/).filter(Boolean);
            if (!who) {
                return { kind: 'error', message: on
                    ? `Usage: /${word} <player> <duration|perm> [reason]`
                    : `Usage: /${word} <player>` };
            }
            // An account-level mute belongs to NO conversation (it is the one
            // moderation verb that needs no membership), so it is a different
            // command rather than `/mute` with a flag — and it is the only one
            // that works from a tab that has no ops at all.
            if (global) {
                if (on) {
                    const secs = parseChatDuration(tail[0] ?? '');
                    if (secs < 0) {
                        return { kind: 'error',
                                 message: 'Usage: /gmute <player> <duration|perm> [reason]' };
                    }
                    return { kind: 'mute', username: who, seconds: secs,
                             reason: tail.slice(1).join(' '), on: true };
                }
                return { kind: 'mute', username: who, seconds: 0, reason: '', on: false };
            }
            if (!active) return { kind: 'error', message: 'No channel selected.' };
            // The service answers this with a 400 and it is worth refusing a
            // round-trip earlier: a moderator who could mute one end of a PM
            // would be reading it, and the tool for two people is the ignore
            // list.
            if (active.scope === 'pm') {
                return { kind: 'error',
                         message: `A PM has no moderators — use /ignore ${who}.` };
            }
            if (!on) {
                return { kind: 'mute', username: who, scope: active.scope,
                         target: active.sendTarget, seconds: 0, reason: '', on: false };
            }
            // A duration is REQUIRED here, unlike on the wire, where its
            // absence means `until lifted`. An indefinite mute is a real
            // decision and `/mute bob` is what a moderator types when they
            // mean five minutes; `perm` makes it deliberate.
            const secs = parseChatDuration(tail[0] ?? '');
            if (secs < 0) {
                return { kind: 'error',
                         message: 'Usage: /mute <player> <duration|perm> [reason] ' +
                                  '(10s, 5m, 2h, 1d)' };
            }
            return { kind: 'mute', username: who, scope: active.scope,
                     target: active.sendTarget, seconds: secs,
                     reason: tail.slice(1).join(' '), on: true };
        }
        case 'kick': {
            const [who, ...tail] = rest.split(/\s+/).filter(Boolean);
            if (!who) return { kind: 'error', message: 'Usage: /kick <player> [duration] [reason]' };
            // Named channels only, and the channel is the one being read
            // rather than one that is named: `/api/chat/kick` refuses `#main`
            // (nobody can leave it) and a room's ejection verb is
            // `/api/rooms/kick` — a player ejected from a room's channel but
            // still seated is in a war they cannot talk to.
            if (!active || active.scope !== 'channel') {
                return { kind: 'error',
                         message: 'Kick applies to a named channel — open its tab first.' };
            }
            const secs = parseChatDuration(tail[0] ?? '');
            const reason = (secs < 0 ? tail : tail.slice(1)).join(' ');
            return { kind: 'kick', channel: active.sendTarget, username: who,
                     seconds: secs < 0 ? 0 : secs, reason };
        }
        case 'broadcast': {
            if (!rest) return { kind: 'error', message: 'Usage: /broadcast <message>' };
            return { kind: 'broadcast', text: rest };
        }
        case 'mutes':
            return { kind: 'mutes' };
        default:
            // Refused rather than sent: a mistyped command that goes out as
            // chat publishes it to the channel, which is how `/w bob <secret>`
            // becomes a room-wide message.
            return { kind: 'error', message: `Unknown command /${word}` };
    }
}

/// Does this line render as an action (`* Bob waves`)?
export function isActionLine(text: string): boolean {
    return text.startsWith('/me ') && text.length > 4;
}

/// The body of an action line, without its marker.
export function actionBody(text: string): string {
    return isActionLine(text) ? text.slice(4) : text;
}

// ── The moderation surface (task 9d, §3.4's client half) ───────────────────

/// The `moderation` SSE event. The service sends it to ONE account — the
/// subject of an account-level mute — and to nobody else, because an
/// account-level mute belongs to no conversation and announcing it in `#main`
/// would make every moderation action a public event. A *scoped* mute has no
/// event: it is told to its channel as a system line, which is why the two
/// halves of this feature render in two different places.
export interface ChatModerationEvent {
    muted: boolean;
    /// Unix seconds, or 0 for *until lifted*.
    until: number;
    reason: string;
    by: string;
}

/// Is this notice still in force at `nowSec`?
///
/// A mute with an expiry stops being true on its own, and a banner that
/// outlives it tells the player they cannot speak while they can. `until = 0`
/// is until-lifted, so only an explicit `muted: false` event ends it — which
/// is why the service emits one on an account-level unmute.
export function moderationActive(ev: ChatModerationEvent | null, nowSec: number): boolean {
    if (!ev || !ev.muted) return false;
    return ev.until === 0 || ev.until > nowSec;
}

/// The banner line for a standing mute.
export function moderationNoticeText(ev: ChatModerationEvent): string {
    const who = ev.by ? ` by ${ev.by}` : '';
    const when = ev.until > 0 ? ` until ${chatTime(ev.until)}` : ' until lifted';
    const why = ev.reason ? ` — ${ev.reason}` : '';
    return `You are muted${who}${when}.${why}`;
}

/// One row of `/api/chat/mute` read with no `username` — the operator's list.
export interface ChatMuteRow {
    account_id: number;
    username?: string;
    /// `"account"` for the global one, else `"<scope>:<target>"` (Chat::MuteKey).
    scope: string;
    until: number;
    permanent: boolean;
    reason: string;
    by: string;
}

/// One line of the mute list. The scope is shown as the operator typed it
/// (`account`, `channel:help`) rather than translated, because it is the
/// string `/unmute` has to be standing in to lift.
export function muteRowLine(m: ChatMuteRow, nowSec: number): string {
    const who = m.username || `#${m.account_id}`;
    const when = m.permanent || m.until === 0
        ? 'until lifted'
        : `${Math.max(0, Math.round((m.until - nowSec) / 60))}m left`;
    const why = m.reason ? ` — ${m.reason}` : '';
    return `${who} · ${m.scope} · ${when} · by ${m.by}${why}`;
}

// ── §3.5 quality of life ───────────────────────────────────────────────────

/// Does this line name me?
///
/// Word-bounded and case-insensitive, and it deliberately does NOT match
/// inside a longer word: a player called `al` would otherwise be mentioned by
/// every "already". The name is escaped into the pattern because a username
/// is user content and `.`/`+` are legal in some of them.
export function hasMention(text: string, username: string): boolean {
    const name = username.trim();
    if (!name) return false;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w])${esc}([^\\w]|$)`, 'i').test(text);
}

/// Should this frame make a noise?
///
/// Three rules, each of which is a complaint when it is missing: never for my
/// own line (a client that pings itself is a client nobody leaves open),
/// never for a system line (the server talks constantly), and never for a
/// tab that is on screen and being read. What is left is a PM or a mention —
/// the two things §3.5 asks for.
export function shouldNotify(
    f: ChatFrame, myId: number, myName: string, activeKey: string,
): boolean {
    if (f.fromId === myId || f.system) return false;
    const isPm = f.scope === 'pm';
    const mention = hasMention(f.text, myName);
    if (!isPm && !mention) return false;
    // A mention still pings in the tab you are reading — it is addressed to
    // you and the panel may not have focus — but an ordinary PM in the open
    // PM tab does not.
    if (tabKey(f.scope, f.target) === activeKey && !mention) return false;
    return true;
}

/// One piece of a rendered line: plain text, or a link.
export interface ChatSegment { text: string; href?: string; }

/// Split a line into text and links (§3.5: "links auto-detected but rendered
/// as plain anchors, no embeds").
///
/// Returns SEGMENTS rather than HTML on purpose. Building the anchor here
/// would mean escaping here, and a linkifier that runs over already-escaped
/// text has to know that `&amp;` is one character — the classic way a chat
/// panel grows an XSS hole. The renderer escapes each segment itself.
///
/// `http`/`https` only: a bare `www.` is ambiguous with ordinary prose, and
/// any other scheme (`javascript:`, `data:`) is exactly what must not become
/// an anchor.
export function linkSegments(text: string): ChatSegment[] {
    const out: ChatSegment[] = [];
    const re = /https?:\/\/[^\s<>"']+/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        if (start > at) out.push({ text: text.slice(at, start) });
        // Trailing punctuation belongs to the sentence, not the url —
        // "see http://x/y." links `http://x/y`.
        let url = m[0];
        const trail = /[.,;:!?)\]}]+$/.exec(url);
        if (trail) url = url.slice(0, url.length - trail[0].length);
        out.push({ text: url, href: url });
        at = start + url.length;
    }
    if (at < text.length) out.push({ text: text.slice(at) });
    return out.length ? out : [{ text }];
}

/// Merge lines into a tab: ascending by id, no duplicates.
///
/// The backfill overlaps the live stream by construction — the client opens
/// the stream FIRST (so nothing said during the fetch is lost) and asks for
/// history second, so any line said in between arrives twice. Dedupe is on
/// `id`, which is the store's rowid and the only identity a line has.
export function mergeMessages(existing: ChatFrame[], incoming: ChatFrame[]): ChatFrame[] {
    const byId = new Map<number, ChatFrame>();
    for (const m of existing) byId.set(m.id, m);
    for (const m of incoming) byId.set(m.id, m);
    const out = [...byId.values()].sort((a, b) => a.id - b.id);
    return out.length > CHAT_TAB_LIMIT ? out.slice(out.length - CHAT_TAB_LIMIT) : out;
}

/// The tab list, in the order the panel shows it.
///
/// `#main` first because it is the one everybody is in; then the room the
/// player is standing in (room → ally → spectator, the order they are used in);
/// then named channels alphabetically; then PMs, most recently active first,
/// because a PM list ordered by name buries the person who just spoke.
export function sortTabs(tabs: ChatTab[]): ChatTab[] {
    const rank = (t: ChatTab): number => {
        switch (t.scope) {
            case 'main': return 0;
            case 'room': return 1;
            case 'ally': return 2;
            case 'spectator': return 3;
            case 'channel': return 4;
            case 'pm': return 5;
        }
    };
    const lastTs = (t: ChatTab): number =>
        t.messages.length ? t.messages[t.messages.length - 1].ts : 0;
    return [...tabs].sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r !== 0) return r;
        if (a.scope === 'pm') {
            const d = lastTs(b) - lastTs(a);
            if (d !== 0) return d;
        }
        return a.label.localeCompare(b.label);
    });
}

/// The three tabs a room contributes, given the seat held in it.
///
/// Ally is absent for a spectator (the server answers 403 — "spectators have
/// no team") and the spectator tab is absent for a player, so neither is a
/// button whose only possible answer is a refusal.
export function roomTabSpecs(seat: RoomSeat, roomName: string): Array<{
    scope: ChatScopeKey; target: string; sendTarget: string; label: string;
}> {
    const id = String(seat.roomId);
    const out: Array<{ scope: ChatScopeKey; target: string; sendTarget: string;
                       label: string }> =
        [{ scope: 'room', target: id, sendTarget: id,
           label: roomName || `Room ${id}` }];
    if (seat.isSpectator) {
        out.push({ scope: 'spectator' as const, target: `${id}/spec`,
                   sendTarget: id, label: 'Spectators' });
    } else {
        out.push({ scope: 'ally' as const, target: `${id}/ally/${seat.team}`,
                   sendTarget: id, label: 'Allies' });
    }
    return out;
}

// ── The stream's recovery policy ───────────────────────────────────────────

/// What the client should do after an `EventSource` error.
export type StreamAction = 'wait' | 'remint' | 'stop';

export interface StreamRecovery {
    action: StreamAction;
    /// How long to wait before acting. 0 for `wait`, where the browser's own
    /// retry is what happens next.
    delayMs: number;
    /// The line the panel shows while this is in effect, or '' for silence —
    /// the first blip of a stream the browser is already retrying is not news.
    notice: string;
}

/// How many failures before the client stops trying and asks the player.
export const CHAT_STREAM_MAX_ATTEMPTS = 6;

/// Decide what to do about a dead chat stream.
///
/// The hard part is that a browser tells the page **nothing** about why an
/// `EventSource` failed: `onerror` carries no status, so a 401 from an expired
/// ticket and a dropped Wi-Fi connection are the same event. And the two want
/// opposite responses — the browser retries the SAME url by itself, which
/// fixes the network case and loops forever on the credential case, because
/// the url it retries carries the dead ticket.
///
/// So: one free auto-retry while the ticket is still plausibly alive, and a
/// re-mint for everything after that (and immediately, if the ticket is past
/// its TTL — the browser's retry of a dead ticket can only fail). Minting is a
/// cheap authenticated POST; looping on a credential that cannot work is not.
/// Backoff is exponential so a lobby that is genuinely down is not hammered,
/// and after `CHAT_STREAM_MAX_ATTEMPTS` the client stops and says so rather
/// than retrying silently for the rest of the session.
export function streamRecovery(
    consecutiveErrors: number,
    ticketAgeSec: number,
    ttlSec: number = CHAT_TICKET_TTL_SEC,
): StreamRecovery {
    if (consecutiveErrors >= CHAT_STREAM_MAX_ATTEMPTS) {
        return { action: 'stop', delayMs: 0,
                 notice: 'Chat is disconnected. Reconnect?' };
    }
    // The ticket's TTL slides on every redemption (SSETickets.h), so an age
    // past the TTL means nothing has redeemed it for a whole window — the
    // stream is not connected and the credential is gone with it.
    const expired = ticketAgeSec >= ttlSec;
    if (consecutiveErrors <= 1 && !expired) {
        return { action: 'wait', delayMs: 0, notice: '' };
    }
    const step = Math.max(0, consecutiveErrors - 1);
    return {
        action: 'remint',
        delayMs: Math.min(1000 * Math.pow(2, step), 30000),
        notice: consecutiveErrors >= 2 ? 'Chat reconnecting…' : '',
    };
}

// ── The panel's state ──────────────────────────────────────────────────────

/// Every tab the panel holds, plus which one is on screen.
///
/// Deliberately DOM-free: the panel renders this, and every rule that decides
/// what a player sees — where a frame lands, what counts as unread, which tabs
/// a room owns — is asserted here instead of through a rendered string.
export class ChatModel {
    private tabs = new Map<string, ChatTab>();
    /// The room whose tabs are currently staged, so a re-render does not
    /// rebuild them and a room change does.
    private roomKeys: string[] = [];
    activeKey = '';
    /// This account's id, used for the two decisions that need to know whose
    /// line it is: own lines are never unread, and a PM's other party is
    /// whichever id in the target is not this one.
    myId = 0;

    constructor(myId = 0) {
        this.myId = myId;
        this.ensureTab({ scope: 'main', target: 'main', sendTarget: 'main',
                         label: '#main', closable: false });
        this.activeKey = tabKey('main', 'main');
    }

    list(): ChatTab[] { return sortTabs([...this.tabs.values()]); }
    get(key: string): ChatTab | null { return this.tabs.get(key) ?? null; }
    active(): ChatTab | null { return this.tabs.get(this.activeKey) ?? null; }
    totalUnread(): number {
        let n = 0;
        for (const t of this.tabs.values()) n += t.unread;
        return n;
    }

    ensureTab(spec: { scope: ChatScopeKey; target: string; sendTarget: string;
                      label: string; closable?: boolean }): ChatTab {
        const key = tabKey(spec.scope, spec.target);
        const found = this.tabs.get(key);
        if (found) {
            // A label can improve — a PM opened from an incoming frame knows
            // the name, one opened from a target does not — but a tab's
            // identity never changes.
            if (spec.label && spec.label !== found.label) found.label = spec.label;
            return found;
        }
        const tab: ChatTab = {
            key, scope: spec.scope, target: spec.target, sendTarget: spec.sendTarget,
            label: spec.label,
            closable: spec.closable ?? (spec.scope === 'pm' || spec.scope === 'channel'),
            messages: [], unread: 0, loaded: false,
        };
        this.tabs.set(key, tab);
        return tab;
    }

    /// Open a PM tab keyed by the canonical target while addressing it by
    /// name. Both halves are needed and they are different strings (rule 1).
    ensurePmTab(otherId: number, username: string): ChatTab {
        return this.ensureTab({
            scope: 'pm', target: pmTarget(this.myId, otherId),
            sendTarget: username, label: username, closable: true,
        });
    }

    setActive(key: string): void {
        if (!this.tabs.has(key)) return;
        this.activeKey = key;
        const t = this.tabs.get(key)!;
        t.unread = 0;
    }

    close(key: string): boolean {
        const t = this.tabs.get(key);
        if (!t || !t.closable) return false;
        this.tabs.delete(key);
        if (this.activeKey === key) this.activeKey = tabKey('main', 'main');
        return true;
    }

    /// File one live frame.
    ///
    /// Returns the tab it landed in, or null when it was dropped. A frame for
    /// a scope this client has no tab for is NOT dropped when it is a PM — the
    /// whole point of a PM is that it arrives unannounced — but it is for a
    /// room or channel, where a frame with no tab means the client left and
    /// the server has not caught up.
    applyFrame(f: ChatFrame): ChatTab | null {
        let tab = this.tabs.get(tabKey(f.scope, f.target)) ?? null;
        if (!tab && f.scope === 'pm') {
            const other = pmOther(f.target, this.myId);
            if (!other) return null;
            // `from` names the other party unless this is my own line echoed
            // back from another device, in which case the id is all there is.
            const label = f.fromId === this.myId ? `#${other}` : f.from;
            tab = this.ensurePmTab(other, label);
        }
        if (!tab) return null;
        tab.messages = mergeMessages(tab.messages, [f]);
        // Own lines are never unread, and neither is the tab you are reading.
        if (tab.key !== this.activeKey && f.fromId !== this.myId) tab.unread++;
        return tab;
    }

    /// File a backfill page. `/api/chat/history` answers newest-first and names
    /// the scope and target once, so the rows are stamped here.
    applyHistory(key: string, rows: Array<Partial<ChatFrame>>): ChatTab | null {
        const tab = this.tabs.get(key);
        if (!tab) return null;
        const stamped: ChatFrame[] = rows
            .filter(r => typeof r.id === 'number')
            .map(r => ({
                id: r.id!, scope: tab.scope, target: tab.target,
                from: r.from ?? '', fromId: r.fromId ?? 0,
                text: r.text ?? '', ts: r.ts ?? 0,
                ...(r.system ? { system: true } : {}),
            }));
        tab.messages = mergeMessages(tab.messages, stamped);
        tab.loaded = true;
        // A backfill is not news: it is what was already said. Counting it
        // would badge every tab the moment the panel opens.
        return tab;
    }

    /// Stage the tabs for the room the client is standing in, and take away
    /// the ones for the room it left (rule 3).
    ///
    /// Returns true when the set changed, so the caller can re-render and
    /// backfill without diffing the DOM.
    syncRoomTabs(seat: RoomSeat | null, roomName = ''): boolean {
        const wanted = seat ? roomTabSpecs(seat, roomName) : [];
        const wantedKeys = wanted.map(s => tabKey(s.scope, s.target));
        const same = wantedKeys.length === this.roomKeys.length &&
                     wantedKeys.every((k, i) => k === this.roomKeys[i]);
        if (same) return false;

        for (const k of this.roomKeys) {
            if (wantedKeys.includes(k)) continue;
            this.tabs.delete(k);
            if (this.activeKey === k) this.activeKey = tabKey('main', 'main');
        }
        for (const s of wanted) {
            this.ensureTab({ ...s, closable: false });
        }
        this.roomKeys = wantedKeys;
        return true;
    }
}

/// `HH:MM` for a unix-seconds stamp, in the reader's own zone.
export function chatTime(ts: number, now: Date = new Date(ts * 1000)): string {
    const d = ts ? new Date(ts * 1000) : now;
    return `${String(d.getHours()).padStart(2, '0')}:` +
           `${String(d.getMinutes()).padStart(2, '0')}`;
}
