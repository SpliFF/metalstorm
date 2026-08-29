/**
 * notice-lane.ts — the ONE way this HUD interrupts the player
 * (DESIGN-DRILLDOWN.md §2/§4; battle-clarity U3)
 *
 * A notice is something that just happened, said once, briefly, and then gone.
 * Two rules make it a lane rather than a feed:
 *
 *   1. **It decays.** Nothing accumulates. An accumulating list beside the
 *      viewport is a resident panel, and a resident panel is the spreadsheet
 *      the directive exists to remove. The record of what happened lives at
 *      rung 4, behind one access point, and is read on purpose.
 *   2. **It is bounded.** `maxVisible` notices at once; the oldest leaves to
 *      make room. A wall of notices is the same wall, in motion.
 *
 * ── Why this file exists at all ──
 *
 * U1 grew a toast queue inside `objective-hud.ts` — a `div.nui-toast`, a
 * `setTimeout`, a `Set` of timers. U3 needs the same thing for battle events,
 * and the brief is explicit that this must be ONE mechanism and not two.
 * Rather than copy it, the queue was lifted out here and U1's widget now pushes
 * into this lane, so there is exactly one set of rules about how long a notice
 * lives and how many may be on screen — and adding a fourth source later costs
 * a `push`, not a fourth timer.
 *
 * ── A notice may be a rung of the ladder ──
 *
 * The directive's whole shape is "anything interesting is one more click away".
 * A notice that reports a fight and cannot be asked about it is a dead end. So
 * a notice may carry a `DrilldownSpec`: the lane then renders the notice AS a
 * rung-1 chip, and clicking it drills into context and camera travel exactly
 * like any other chip in the HUD. Plain-text notices (an objective changed —
 * its own chip is already on screen, one line up) stay plain.
 *
 * ── The one timing rule that is not a constant ──
 *
 * **A notice the player is reading does not expire.** Its clock is paused while
 * the pointer is over the lane and while its own context panel is open;
 * otherwise the panel a player just opened would be torn out from under them
 * mid-sentence, which reads as a crash rather than as a timeout.
 */

import { createDrilldown, type DrilldownHandle, type DrilldownSpec } from './drilldown.js';

/** How long a notice stays on screen, in ms of NOT being read. Long enough to
 *  notice mid-fight, short enough that nothing piles up. */
export const NOTICE_MS = 9000;

/** How many notices may share the screen. Beyond this the oldest goes. */
export const MAX_NOTICES = 4;

export type NoticeTone = 'good' | 'bad' | 'accent';

export interface Notice {
    /** Identity. Pushing the same key again REPLACES rather than stacks — the
     *  same news twice is one piece of news that got louder. */
    key: string;
    /** The one line. Ignored when `drilldown` is given: the chip's own summary
     *  is the line, and two spellings of one event is the defect
     *  `objective-phrasing.ts` exists to prevent. */
    text?: string;
    tone?: NoticeTone;
    /** Present ⇒ this notice is a rung-1 affordance and clicking it drills. */
    drilldown?: DrilldownSpec;
    /** Override the lane default. */
    ttlMs?: number;
}

export interface NoticeLane {
    push(notice: Notice): void;
    /** Re-read every live chip's summary — a fight's numbers keep moving after
     *  the notice went up. No-op for plain-text notices. */
    refresh(): void;
    /** How many notices are on screen. Used by the widget's "is anything in my
     *  DOM" check, and by the tests. */
    size(): number;
    clear(): void;
    dispose(): void;
}

interface LiveNotice {
    key: string;
    el: HTMLElement;
    handle: DrilldownHandle | null;
    /** Wall clock at which it goes. */
    expiresAt: number;
    ttlMs: number;
}

export interface NoticeLaneOptions {
    maxVisible?: number;
    defaultTtlMs?: number;
    /** Injectable clock, so a test can run a whole battle without waiting. */
    now?: () => number;
    /** Injectable sweep driver. Absent ⇒ a 500 ms interval. */
    sweepMs?: number;
}

/**
 * Mount a lane inside `host`. The host is emptied of nothing and owns nothing —
 * a widget may keep other children there.
 */
export function createNoticeLane(
    host: HTMLElement, opts: NoticeLaneOptions = {},
): NoticeLane {
    const maxVisible = opts.maxVisible ?? MAX_NOTICES;
    const defaultTtl = opts.defaultTtlMs ?? NOTICE_MS;
    const now = opts.now ?? (() => Date.now());

    const lane = document.createElement('div');
    lane.className = 'nui-toasts nui-notices';
    host.append(lane);

    const live: LiveNotice[] = [];
    let hovered = false;
    let disposed = false;

    // Hover pauses the whole lane, not one notice: the notices are stacked and
    // a player reading the second one is inevitably hovering over it.
    lane.addEventListener('pointerenter', () => { hovered = true; });
    lane.addEventListener('pointerleave', () => { hovered = false; });

    const remove = (n: LiveNotice): void => {
        n.handle?.dispose();
        n.el.remove();
        const i = live.indexOf(n);
        if (i >= 0) live.splice(i, 1);
    };

    const sweep = (): void => {
        if (disposed) return;
        const t = now();
        for (const n of [...live]) {
            if (hovered || n.handle?.isExpanded()) {
                // Held: push the deadline out so it gets its full read time
                // once attention moves on, rather than vanishing at once.
                n.expiresAt = t + n.ttlMs;
                continue;
            }
            if (t >= n.expiresAt) remove(n);
        }
    };

    const timer = setInterval(sweep, opts.sweepMs ?? 500);

    return {
        push(notice: Notice): void {
            if (disposed) return;
            const existing = live.find((n) => n.key === notice.key);
            if (existing) remove(existing);

            const el = document.createElement('div');
            el.className = 'nui-toast';
            el.dataset.noticeKey = notice.key;
            if (notice.tone) el.classList.add(`nui-toast--${notice.tone}`);

            let handle: DrilldownHandle | null = null;
            if (notice.drilldown) {
                el.classList.add('nui-toast--drill');
                handle = createDrilldown(notice.drilldown);
                el.append(handle.el);
            } else {
                el.textContent = notice.text ?? '';
            }

            lane.append(el);
            const ttlMs = notice.ttlMs ?? defaultTtl;
            live.push({ key: notice.key, el, handle, ttlMs, expiresAt: now() + ttlMs });
            while (live.length > maxVisible) remove(live[0]);
        },
        refresh(): void {
            for (const n of live) n.handle?.refresh();
        },
        size: () => live.length,
        clear(): void {
            for (const n of [...live]) remove(n);
        },
        dispose(): void {
            disposed = true;
            clearInterval(timer);
            for (const n of [...live]) remove(n);
            lane.remove();
        },
    };
}
