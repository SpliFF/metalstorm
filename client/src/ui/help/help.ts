/**
 * help.ts — the player help drawer (PLAN-beta-journey.md §(e)).
 *
 * `openHelp(topic)` slides a drawer in from the right with
 * docs/player-guide.md rendered by guide-md.ts, scrolled to `topic`. One
 * drawer per page, created on first use; it works on the lobby and over the
 * game HUD alike, which is why it is not a lobby template. "Start the
 * tutorial" is the one action it carries: a `?play=tutorial_01` navigation.
 */

import guideMd from '../../../../docs/player-guide.md?raw';
import helpCss from './help.css?raw';
import { findSection, renderGuide } from './guide-md.js';

export const TUTORIAL_SCENARIO = 'tutorial_01';

/// The URL a "Start the tutorial" control navigates to. The game id is kept
/// so the lobby styles itself for the same game after the reload.
export function tutorialUrl(search: string): string {
    const q = new URLSearchParams(search.replace(/^\?/, ''));
    const game = q.get('game');
    const next = new URLSearchParams();
    next.set('play', TUTORIAL_SCENARIO);
    if (game) next.set('game', game);
    return `?${next.toString()}`;
}

let drawer: HTMLElement | null = null;

function ensureDrawer(): HTMLElement {
    if (drawer && document.body.contains(drawer)) return drawer;
    if (!document.getElementById('help-styles')) {
        const s = document.createElement('style');
        s.id = 'help-styles';
        s.textContent = helpCss;
        document.head.appendChild(s);
    }
    const { html } = renderGuide(guideMd);
    const el = document.createElement('aside');
    el.id = 'help-drawer';
    el.className = 'help-drawer';
    el.innerHTML = `
        <div class="help-scrim"></div>
        <div class="help-panel" role="dialog" aria-label="Player guide">
            <header class="help-head">
                <span class="help-kicker">Field manual</span>
                <button type="button" class="help-close" id="help-close" aria-label="Close">✕</button>
            </header>
            <div class="help-actions">
                <button type="button" class="help-tutorial" id="help-tutorial">Start the tutorial</button>
                <span class="help-actions-hint">A short Solo Mission. Counts toward your Standing.</span>
            </div>
            <div class="help-body" id="help-body">${html}</div>
        </div>`;
    document.body.appendChild(el);
    el.querySelector('.help-scrim')!.addEventListener('click', closeHelp);
    el.querySelector('#help-close')!.addEventListener('click', closeHelp);
    el.querySelector('#help-tutorial')!.addEventListener('click', () => {
        window.location.href = tutorialUrl(window.location.search);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isHelpOpen()) closeHelp(); });
    drawer = el;
    return el;
}

export function openHelp(topic?: string): void {
    const el = ensureDrawer();
    el.classList.add('help-open');
    const { sections } = renderGuide(guideMd);
    const section = findSection(sections, topic);
    const body = el.querySelector('#help-body') as HTMLElement;
    const target = section ? el.querySelector(`#help-${section.id}`) as HTMLElement | null : null;
    requestAnimationFrame(() => {
        if (target) body.scrollTop = target.offsetTop - body.offsetTop - 8;
        else body.scrollTop = 0;
    });
}

export function closeHelp(): void {
    drawer?.classList.remove('help-open');
}

export function isHelpOpen(): boolean {
    return !!drawer?.classList.contains('help-open');
}

// Reachable from the HUD, the console and automation without an import.
(globalThis as any).openHelp = openHelp;
