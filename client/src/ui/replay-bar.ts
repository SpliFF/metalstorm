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
}

const SIM_HZ = 30;

function clock(frame: number): string {
    const s = Math.max(0, Math.floor(frame / SIM_HZ));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Everything the bar shows, derived from one ReplayState plus who we are.
 *  Pure — this is the part with decisions in it. */
export function describeReplayBar(
    st: ReplayStateInfo, myPlayerNum: number, refusal = ''): ReplayBarModel {
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
    if (st.seeking) bits.push(`seeking to ${clock(st.seekTarget)}…`);
    // E1: a recording whose server died mid-game. Said out loud, because the
    // alternative is a bar that just stops and reads as a bug.
    if (st.truncated) bits.push('recording ends early (segment truncated)');
    bits.push(st.povTeam >= 0 ? `POV: team ${st.povTeam}` : 'POV: global view');
    if (st.checkpointFrames.length === 0)
        bits.push('no checkpoints — playback runs forwards only');

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

/** Mount (or refresh) the bar from a ReplayState. Idempotent — call it on
 *  every update. */
export function updateReplayBar(st: ReplayStateInfo, playerNum: number,
                                sender: ReplayControlSender): void {
    lastState = st;
    send = sender;
    myPlayerNum = playerNum;
    if (!root) root = buildBar();
    render();
}

export function hideReplayBar(): void {
    root?.remove();
    root = null;
    lastState = null;
    send = null;
    refusal = '';
    if (refusalTimer) { clearTimeout(refusalTimer); refusalTimer = null; }
}

/** Test seam: the bar's current model, or null when it is not mounted. */
export function replayBarModel(): ReplayBarModel | null {
    return lastState ? describeReplayBar(lastState, myPlayerNum, refusal) : null;
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
    const m = describeReplayBar(lastState, myPlayerNum, refusal);
    const play  = root.querySelector<HTMLButtonElement>('#replay-play');
    const speed = root.querySelector<HTMLButtonElement>('#replay-speed');
    const pos   = root.querySelector<HTMLElement>('#replay-position');
    const fill  = root.querySelector<HTMLElement>('#replay-fill');
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
    if (status) {
        status.textContent = m.refusal
            ? m.refusal
            : (m.disabledReason ? `${m.status} · ${m.disabledReason}` : m.status);
        status.style.color = m.refusal ? '#fca5a5' : '';
        status.style.opacity = m.refusal ? '1' : '0.72';
    }
}
