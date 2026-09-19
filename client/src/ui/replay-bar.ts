/**
 * Replay playback bar — pause/resume, speed, seek and POV for a spectator
 * watching a recorded game (PLAN-replay.md task 4b).
 *
 * Engine-level DOM, like the spectator banner it sits under, and for the same
 * reason: watching a replay is not a Metalstorm HUD concept, and the bar has
 * to survive a worker recycle (the connection lives in the game worker; this
 * does not).
 *
 * MODE DETECTION IS THE ABSENCE OF A MESSAGE. A live game never sends
 * `ReplayState`; a replay server sends one on auth, on every control that
 * lands and on a ~1 s heartbeat. So the bar mounts on the first update and is
 * never shown otherwise — no URL flag, no lobby hint (the lobby cannot list
 * replay files at all yet, PLAN-replay T4a-2), nothing to get out of step.
 *
 * The rendering half is deliberately thin over `describeReplayBar`, which is
 * pure and tested: what the buttons say, whether they are yours to press, and
 * what a frame maps to on the scrub track are the parts worth stating.
 */

import type { ReplayStateInfo } from '../core/connection.js';

/** Mirrors `SpringWeb::ReplayControlAction` — kept as literals so this module
 *  does not drag the generated flatbuffers surface onto the main thread. */
export const ReplayAction = {
    Pause: 0,
    Resume: 1,
    SetSpeed: 2,
    Seek: 3,
    SetPovTeam: 4,
} as const;

/** Speeds offered in the UI. The server clamps to [0.25, 8]; offering
 *  anything outside that would be offering a button that gets clamped. */
export const SPEED_STEPS = [0.5, 1, 2, 4, 8] as const;

export interface ReplayBarModel {
    /** Frames elapsed / total, as `m:ss` at 30 sim Hz. */
    positionLabel: string;
    /** 0..1 along the scrub track. */
    progress: number;
    /** True when this client holds the controls and the buttons do something. */
    isController: boolean;
    /** Why the controls are disabled, or '' when they are not. */
    disabledReason: string;
    /** Text of the play/pause button. */
    playLabel: string;
    speedLabel: string;
    /** Status line under the bar: seek progress, truncation, POV. */
    status: string;
    /** The server's reason for refusing the last control, if it is still
     *  fresh. Wins the status line — a refusal is the one thing on this bar a
     *  watcher is actively waiting to read. */
    refusal: string;
    /** Checkpoint tick positions, 0..1. Empty until PLAN-persistence's sim
     *  serializer lands and recordings start carrying checkpoints. */
    tickPositions: number[];
    /** True for a Mission Broadcast (delayed relay, not a finished
     *  recording) — hides POV (the log is global-view only) and allows
     *  backward seek even with zero legacy checkpoints. */
    isBroadcast: boolean;
    /** 0..1 position of the live edge on the track, or null outside a
     *  broadcast (a finished recording has no edge to mark). */
    liveEdgePosition: number | null;
}

/** "1h behind" / "45m behind" — the server's floor is 1h but a dev override
 *  can lower it for the live-verification recipe, so this formats whatever
 *  arrives rather than assuming an hour. */
function behindLabel(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    if (h >= 1) return `${h}h behind`;
    return `${Math.max(1, Math.round(s / 60))}m behind`;
}

/** Same rendering broadcast-browser.ts's listing uses for `available_since`
 *  (E2E1's fix e4ced580f7 for that field's UNIX-**seconds** scale) — this
 *  one already works in milliseconds, so there is no scale to get wrong. */
function shortDate(ms: number): string {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

const SIM_HZ = 30;

function clock(frame: number): string {
    const s = Math.max(0, Math.floor(frame / SIM_HZ));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Everything the bar shows, derived from one ReplayState plus who we are.
 *  Pure — this is the part with decisions in it.
 *
 *  `recordedAtMs` is the wall-clock instant a finished/stale broadcast
 *  segment was captured, supplied by the caller (`updateReplayBar` freezes
 *  it from the first state it sees — see the note there for why). Unused
 *  outside a broadcast, and for a still-live one. */
export function describeReplayBar(
    st: ReplayStateInfo, myPlayerNum: number, refusal = '',
    recordedAtMs: number | null = null): ReplayBarModel {
    const span = Math.max(1, st.endFrame - st.startFrame);
    const elapsed = Math.min(Math.max(0, st.currentFrame - st.startFrame), span);
    const isController =
        st.controllerPlayerNum >= 0 && st.controllerPlayerNum === myPlayerNum;

    let disabledReason = '';
    if (!isController) {
        disabledReason = st.controllerPlayerNum < 0
            ? 'waiting for playback controls'
            : `player ${st.controllerPlayerNum} is driving this replay`;
    }

    const bits: string[] = [];
    // A broadcast leads with what makes it a broadcast. `behindSeconds` is
    // the relay's cursor position vs. wall clock — meaningful only while the
    // segment is still live (`truncated`, i.e. no trailer written yet); for
    // a finished/stale one it just measures how long ago the log ended, and
    // a backward seek moves the cursor further from "now" and inflates it
    // further still (E2E1 D12: "1h behind" → "59h behind" on a two-day-old
    // segment after seeking backward). So a finished segment states when it
    // was recorded instead — a fact that does not change under a seek.
    // POV never shows either way (the tap is a Global-visibility spectator —
    // there is no other POV to switch to) and the "no checkpoints" line is
    // wrong here — a broadcast seeks backward via keyframes, checkpoints or
    // not.
    if (st.broadcast) {
        bits.push(st.truncated
            ? `Broadcast · ${behindLabel(st.behindSeconds)}`
            : (recordedAtMs !== null ? `Recorded ${shortDate(recordedAtMs)}` : 'Recorded'));
    }
    if (st.seeking) bits.push(`seeking to ${clock(st.seekTarget)}…`);
    // E1: a recording whose server died mid-game. Said out loud, because the
    // alternative is a bar that just stops and reads as a bug. `truncated`
    // means something else entirely for a broadcast (no trailer yet — it's
    // simply still live, the expected state for its whole run), so this only
    // applies to a finished (`.msr`) recording.
    if (!st.broadcast && st.truncated) bits.push('recording ends early (segment truncated)');
    if (!st.broadcast) {
        bits.push(st.povTeam >= 0 ? `POV: team ${st.povTeam}` : 'POV: global view');
        if (st.checkpointFrames.length === 0)
            bits.push('no checkpoints — playback runs forwards only');
    }

    return {
        positionLabel: `${clock(elapsed)} / ${clock(span)}`,
        progress: elapsed / span,
        isController,
        disabledReason,
        playLabel: st.paused ? '▶' : '❚❚',
        speedLabel: `${st.speed}×`,
        status: bits.join(' · '),
        refusal,
        tickPositions: st.checkpointFrames
            .map((f) => (f - st.startFrame) / span)
            .filter((p) => p >= 0 && p <= 1),
        isBroadcast: st.broadcast,
        liveEdgePosition: st.broadcast
            ? Math.min(1, Math.max(0, (st.liveEdgeFrame - st.startFrame) / span))
            : null,
    };
}

/** Frame a click at `fraction` along the scrub track asks for. Separate from
 *  the DOM so the arithmetic is testable: an off-by-one here is a seek to the
 *  wrong minute of somebody's match. */
export function seekFrameFor(st: ReplayStateInfo, fraction: number): number {
    const f = Math.min(1, Math.max(0, fraction));
    return Math.round(st.startFrame + f * (st.endFrame - st.startFrame));
}

/** Sends a control to the server. Supplied by the caller so this module never
 *  reaches for the worker itself. */
export type ReplayControlSender =
    (action: number, opts?: { speed?: number; frame?: number; povTeam?: number }) => void;

let root: HTMLElement | null = null;
let lastState: ReplayStateInfo | null = null;
let send: ReplayControlSender | null = null;
let myPlayerNum = -1;
let refusal = '';
let refusalTimer: ReturnType<typeof setTimeout> | null = null;
/** E2E1 D12: when this session's broadcast segment turns out to be
 *  finished/stale, the wall-clock instant it was recorded — frozen from the
 *  first state that revealed it, not recomputed on every update. See the
 *  note on `describeReplayBar`'s `recordedAtMs` param. */
let recordedAtMs: number | null = null;

/** How long a refusal holds the status line. Long enough to read a sentence,
 *  short enough that it does not outlive the state it was about. */
const REFUSAL_MS = 6000;

/** Show the server's reason for refusing a control. Called from the
 *  connection's 403 path — see the note in game-processor's onServerError:
 *  the console was not a place a watcher looks. */
export function showReplayRefusal(message: string): void {
    refusal = message;
    if (refusalTimer) clearTimeout(refusalTimer);
    refusalTimer = setTimeout(() => {
        refusal = '';
        refusalTimer = null;
        render();
    }, REFUSAL_MS);
    render();
}

/// A `?watch=<file>&frame=N` deep link's start frame, waiting for the bar to
/// be attached (PLAN-replay task 4c). 0 = none.
let deepLinkSeekFrame = 0;

/** Publish a deep link's start frame. It is applied as an ordinary Seek the
 *  first moment this client is attached and holds the controls — NOT as a
 *  launch option on the replay server, which stalls the server's network loop
 *  through the whole fast-forward and times the watcher out before it can
 *  attach at all (measured; see the watch route in lobby_main.cpp). */
export function setDeepLinkSeekFrame(frame: number): void {
    deepLinkSeekFrame = Math.max(0, Math.floor(frame));
}

/** Whether a published deep-link frame should be sent as a seek right now.
 *
 *  Pure, because every clause is a way to get it wrong: sending it while
 *  another seek is in flight re-queues the same jump, sending it when someone
 *  else drives the cast earns a refusal toast the watcher did not ask for, and
 *  sending it when playback has already passed the target is a backward seek —
 *  which this build refuses. */
export function shouldApplyDeepLinkSeek(
    st: ReplayStateInfo, myPlayerNum: number, frame: number): boolean {
    if (frame <= 0) return false;
    if (st.seeking) return false;
    if (st.controllerPlayerNum < 0 || st.controllerPlayerNum !== myPlayerNum) return false;
    if (frame >= st.endFrame) return false;
    return frame > st.currentFrame;
}

/** Mount (or refresh) the bar from a ReplayState. Idempotent — call it on
 *  every update. */
export function updateReplayBar(st: ReplayStateInfo, playerNum: number,
                                sender: ReplayControlSender): void {
    lastState = st;
    send = sender;
    myPlayerNum = playerNum;
    // D12: capture once, the first time this segment is seen to be
    // finished/stale rather than live. A later seek moves the playback
    // cursor and would otherwise re-derive a bogus, ever-growing "behind" —
    // freezing the wall-clock instant here means the label it feeds
    // (`describeReplayBar`'s "Recorded <date>") never moves under a seek.
    if (st.broadcast && !st.truncated && recordedAtMs === null) {
        recordedAtMs = Date.now() - st.behindSeconds * 1000;
    }
    if (!root) root = buildBar();
    render();

    // One-shot, and cleared whether or not it was sendable: a deep link is a
    // request about the moment the watcher arrived, and re-trying it every
    // second would fight whoever is driving. It waits for `playerNum` to be
    // known, though — a state that lands before the auth reply has been
    // handled would otherwise burn the request on "I am nobody".
    if (deepLinkSeekFrame > 0 && playerNum >= 0) {
        const frame = deepLinkSeekFrame;
        deepLinkSeekFrame = 0;
        if (shouldApplyDeepLinkSeek(st, playerNum, frame))
            sender(ReplayAction.Seek, { frame });
    }
}

export function hideReplayBar(): void {
    root?.remove();
    root = null;
    lastState = null;
    send = null;
    refusal = '';
    recordedAtMs = null;
    if (refusalTimer) { clearTimeout(refusalTimer); refusalTimer = null; }
}

/** Test seam: the bar's current model, or null when it is not mounted. */
export function replayBarModel(): ReplayBarModel | null {
    return lastState ? describeReplayBar(lastState, myPlayerNum, refusal, recordedAtMs) : null;
}

function el(tag: string, css: string, text = ''): HTMLElement {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
}

function buildBar(): HTMLElement {
    const bar = el('div', 'position:fixed;bottom:8px;left:50%;transform:translateX(-50%);' +
        'z-index:200;display:flex;flex-direction:column;gap:4px;width:min(680px,90vw);' +
        'padding:8px 12px;border-radius:8px;background:rgba(20,20,24,0.88);color:#fff;' +
        'font:13px system-ui,sans-serif;pointer-events:auto;');
    bar.id = 'replay-bar';

    const row = el('div', 'display:flex;align-items:center;gap:10px;');
    const play = el('button', buttonCss(), '▶');
    play.id = 'replay-play';
    play.onclick = () => {
        if (!lastState) return;
        send?.(lastState.paused ? ReplayAction.Resume : ReplayAction.Pause);
    };

    const speed = el('button', buttonCss(), '1×');
    speed.id = 'replay-speed';
    speed.onclick = () => {
        if (!lastState) return;
        // Cycle: one button, five stops. A dropdown for five values that the
        // server clamps anyway is more chrome than choice.
        const i = SPEED_STEPS.findIndex((s) => s >= lastState!.speed);
        const next = SPEED_STEPS[(i < 0 ? 0 : i + 1) % SPEED_STEPS.length];
        send?.(ReplayAction.SetSpeed, { speed: next });
    };

    const pos = el('span', 'font-variant-numeric:tabular-nums;min-width:88px;');
    pos.id = 'replay-position';

    const track = el('div', 'position:relative;flex:1;height:8px;border-radius:4px;' +
        'background:rgba(255,255,255,0.18);cursor:pointer;');
    track.id = 'replay-track';
    const fill = el('div', 'position:absolute;left:0;top:0;bottom:0;width:0%;' +
        'border-radius:4px;background:#3b82f6;');
    fill.id = 'replay-fill';
    track.appendChild(fill);
    // Broadcast only: where the delay currently allows playback up to.
    // Absolute-positioned so it sits over the fill rather than in flow.
    const liveEdge = el('div', 'position:absolute;top:-2px;bottom:-2px;width:2px;' +
        'background:#f59e0b;display:none;');
    liveEdge.id = 'replay-live-edge';
    track.appendChild(liveEdge);
    track.onclick = (ev: MouseEvent) => {
        if (!lastState) return;
        const r = track.getBoundingClientRect();
        if (r.width <= 0) return;
        send?.(ReplayAction.Seek,
               { frame: seekFrameFor(lastState, (ev.clientX - r.left) / r.width) });
    };

    const pov = el('button', buttonCss(), 'POV');
    pov.id = 'replay-pov';
    pov.onclick = () => {
        if (!lastState) return;
        // Global ⇄ the team the recording's first army is on. A full team
        // picker needs the roster, which is 4c's surface; this is the switch
        // §2 asks for ("switching POV = standard spectator team-switch") with
        // the two states that exist without one.
        send?.(ReplayAction.SetPovTeam,
               { povTeam: lastState.povTeam >= 0 ? -1 : 0 });
    };

    row.append(play, speed, pos, track, pov);
    const status = el('div', 'font-size:11px;opacity:0.72;');
    status.id = 'replay-status';
    bar.append(row, status);
    document.body.appendChild(bar);
    return bar;
}

function buttonCss(): string {
    return 'cursor:pointer;padding:2px 10px;border-radius:4px;border:none;' +
        'background:#374151;color:#fff;font:inherit;min-width:38px;';
}

function render(): void {
    if (!root || !lastState) return;
    const m = describeReplayBar(lastState, myPlayerNum, refusal, recordedAtMs);
    const play  = root.querySelector<HTMLButtonElement>('#replay-play');
    const speed = root.querySelector<HTMLButtonElement>('#replay-speed');
    const pos   = root.querySelector<HTMLElement>('#replay-position');
    const fill  = root.querySelector<HTMLElement>('#replay-fill');
    const liveEdge = root.querySelector<HTMLElement>('#replay-live-edge');
    const pov   = root.querySelector<HTMLButtonElement>('#replay-pov');
    const status = root.querySelector<HTMLElement>('#replay-status');
    if (play) {
        play.textContent = m.playLabel;
        play.disabled = !m.isController;
        play.style.opacity = m.isController ? '1' : '0.45';
    }
    if (speed) {
        speed.textContent = m.speedLabel;
        speed.disabled = !m.isController;
        speed.style.opacity = m.isController ? '1' : '0.45';
    }
    if (pos) pos.textContent = m.positionLabel;
    if (fill) fill.style.width = `${(m.progress * 100).toFixed(2)}%`;
    // Broadcast: no POV to switch (Global-visibility only), live-edge marker
    // shown instead.
    if (pov) pov.style.display = m.isBroadcast ? 'none' : '';
    if (liveEdge) {
        liveEdge.style.display = m.liveEdgePosition === null ? 'none' : '';
        if (m.liveEdgePosition !== null)
            liveEdge.style.left = `${(m.liveEdgePosition * 100).toFixed(2)}%`;
    }
    if (status) {
        status.textContent = m.refusal
            ? m.refusal
            : (m.disabledReason ? `${m.status} · ${m.disabledReason}` : m.status);
        status.style.color = m.refusal ? '#fca5a5' : '';
        status.style.opacity = m.refusal ? '1' : '0.72';
    }
}
