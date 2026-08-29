/**
 * briefing-panel.ts — the story, the advice and the clock, still reachable
 * (DESIGN-DRILLDOWN.md §6, rung 4; battle-clarity U3)
 *
 * The brief's third ask: "the briefing's story+tips, par timer / victory
 * condition state, statistics and detailed reports are REACHABLE — one
 * summonable surface, not resident panels."
 *
 * Everything here already existed and was unreachable. `ui/briefing/` renders a
 * splash over the loading canvas with the scenario's story, its field advice
 * and its par time, and `main.ts` dropped the whole record on the floor the
 * moment the player clicked **Begin** — so the one text explaining what this
 * battle IS could be read exactly once, before the player had seen the map it
 * describes. A new player who skipped it (or who was launched with
 * `?skipBriefing=1`) never saw it at all.
 *
 * ── Why the par time is a live clock here and a static line there ──
 *
 * On the splash "Par time 12:00" is a target. Mid-battle the useful form is the
 * comparison — how long this has taken against how long it should — so this
 * renders elapsed against par and says plainly when par has passed. It reads
 * the same non-notifying `getGameFrame` mirror the objective countdowns do, on
 * the same 1 Hz tick, because the scene feed is 30 Hz and PLAN-native-ui.md
 * forbids letting it drive DOM.
 *
 * Nothing here is derived: every field is authored scenario text, rendered with
 * `textContent` because generated scenarios put untrusted prose in `story`
 * (the same rule `briefing.ts` states in its own header).
 */

import { uiStore } from './ui-store.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** How often the par clock re-reads the sim frame. */
export const REFRESH_MS = 1000;

/** `615` → `"10:15"`. Same shape as `briefing.ts`'s `formatParTime`, on
 *  seconds, so the splash and this tab format one number one way. */
export function formatClock(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * "7:22 elapsed of 12:00 par" / "7:22 elapsed — 1:22 past par".
 *
 * Exported and pure because the wording is the interesting part: a par timer
 * that silently keeps counting past par has stopped answering the question it
 * was asked.
 */
export function parPhrase(elapsedSec: number, parSec: number | undefined): string {
    const elapsed = formatClock(elapsedSec);
    if (!parSec || parSec <= 0) return `${elapsed} elapsed`;
    const over = elapsedSec - parSec;
    return over > 0
        ? `${elapsed} elapsed — ${formatClock(over)} past par (${formatClock(parSec)})`
        : `${elapsed} elapsed of ${formatClock(parSec)} par`;
}

const briefingPanel: Widget = {
    id: 'briefing-panel',
    init(ctx: WidgetContext): void { mount(ctx); },
    dispose(): void { teardown?.(); teardown = null; },
};

let teardown: (() => void) | null = null;

function mount(ctx: WidgetContext): void {
    teardown?.();

    const root = document.createElement('div');
    root.className = 'nui-briefing';
    ctx.mount.append(root);

    const render = (): void => {
        root.replaceChildren();
        const b = uiStore.getBriefing();
        const elapsed = Math.max(0, Math.floor(uiStore.getGameFrame() / 30));

        const clock = document.createElement('div');
        clock.className = 'nui-briefing__clock';
        clock.textContent = parPhrase(elapsed, b?.parTimeSec);
        root.append(clock);

        if (!b) {
            // Say WHY rather than rendering an empty tab: this battle may
            // simply not be a scenario, and a blank pane reads as broken.
            const none = document.createElement('p');
            none.className = 'nui-log__empty';
            none.textContent = 'This battle shipped no briefing.';
            root.append(none);
            return;
        }

        if (b.title) {
            const h = document.createElement('h3');
            h.className = 'nui-briefing__title';
            h.textContent = b.title;
            root.append(h);
        }
        if (b.subtitle) {
            const sub = document.createElement('p');
            sub.className = 'nui-briefing__subtitle';
            sub.textContent = b.subtitle;
            root.append(sub);
        }
        for (const para of (b.story ?? '').split(/\n\s*\n/)) {
            const text = para.trim();
            if (!text) continue;
            const p = document.createElement('p');
            p.className = 'nui-briefing__para';
            p.textContent = text;
            root.append(p);
        }
        if (b.tips.length > 0) {
            const h = document.createElement('h4');
            h.className = 'nui-briefing__tips-head';
            h.textContent = 'Field advice';
            const ul = document.createElement('ul');
            ul.className = 'nui-briefing__tips';
            for (const tip of b.tips) {
                const li = document.createElement('li');
                li.textContent = tip;
                ul.append(li);
            }
            root.append(h, ul);
        }
    };

    const unsubscribe = uiStore.subscribe(['briefing'], render);
    const timer = setInterval(render, REFRESH_MS);
    render();

    teardown = () => { unsubscribe(); clearInterval(timer); root.remove(); };
}

export default briefingPanel;
