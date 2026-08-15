/**
 * Scenario briefing splash (PLAN-test-automation S2).
 *
 * The story, the field advice and a banner, shown over the loading canvas
 * while a scenario war boots, with a **Begin** button that arms only when the
 * game is actually ready.
 *
 * THE GAME BOOTS UNDERNEATH IT. The splash is an overlay and nothing else: it
 * never gates the connection, the spawn or the sim. That is deliberate — a
 * lobby-launched war can hold other humans, and one player's reading speed
 * must not pause a shared server. Begin dismisses DOM, full stop.
 *
 * ALL AUTHORED TEXT GOES IN VIA textContent. Briefing prose can come from the
 * `generated_scenarios` table, so it is untrusted data; the HTML template
 * carries chrome only and `renderTemplate` (ui.ts) — which does no escaping —
 * is never used here.
 */

import { injectStyle } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';
import type { ScenarioBriefing } from '../../lobby/scenario-picker.js';

/// Handle on a mounted splash. `notifyReady` arms Begin; `dismiss` tears the
/// overlay down unconditionally (used by every teardown path in main.ts, so a
/// splash can never outlive the boot it belongs to).
export interface BriefingHandle {
    notifyReady(): void;
    dismiss(): void;
}

export interface BriefingOptions {
    /// Shown when the briefing authored no `title` — the scenario's display
    /// name. A splash always has a headline.
    fallbackTitle: string;
    /// Banner URL, or null to hide the banner entirely. The caller resolves
    /// authored art vs. the map-thumbnail fallback; this component only
    /// renders what it is handed and hides the row if it fails to load.
    imageUrl: string | null;
    /// Invoked after the overlay is removed by a Begin click. Not called by
    /// `dismiss()` — that is a teardown, not a player decision.
    onBegin: () => void;
}

/// `615` → `"10:15"`. Seconds are always two digits; hours roll into minutes
/// (a 90-minute par time reads `90:00`, which is truer than `1:30:00` for a
/// number the player compares against a match clock).
export function formatParTime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    return `${mins}:${String(secs).padStart(2, '0')}`;
}

/// Split a story into paragraphs on blank lines, dropping empties. Exported
/// for the test that pins the paragraph contract the authored `[[...]]`
/// blocks rely on.
export function storyParagraphs(story: string): string[] {
    return story.split(/\n\s*\n/).map(p => p.trim()).filter(p => p !== '');
}

function setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

export function showBriefingSplash(
    templates: GameTemplates,
    briefing: ScenarioBriefing,
    opts: BriefingOptions,
): BriefingHandle {
    injectStyle('briefing-style', templates.briefingCss);

    // Idempotent. A re-entry into the same room can mount a second splash on
    // top of the first, and the second one's Begin would then reveal the
    // first — so the old node goes before the new one arrives.
    document.getElementById('briefing-overlay')?.remove();

    const overlay = Object.assign(document.createElement('div'), { id: 'briefing-overlay' });
    overlay.innerHTML = templates.briefingHtml;   // static chrome only
    document.body.appendChild(overlay);

    setText('briefing-title', briefing.title ?? opts.fallbackTitle);
    setText('briefing-subtitle', briefing.subtitle ?? '');

    const storyEl = document.getElementById('briefing-story');
    if (storyEl) {
        for (const para of storyParagraphs(briefing.story ?? '')) {
            const p = document.createElement('p');
            p.textContent = para;
            storyEl.appendChild(p);
        }
    }

    const tipsEl = document.getElementById('briefing-tips');
    if (briefing.tips.length === 0) {
        document.getElementById('briefing-tips-wrap')?.classList.add('briefing-hidden');
    } else if (tipsEl) {
        for (const tip of briefing.tips) {
            const li = document.createElement('li');
            li.textContent = tip;
            tipsEl.appendChild(li);
        }
    }

    const parEl = document.getElementById('briefing-partime');
    if (briefing.parTimeSec && parEl) {
        parEl.textContent = `Par time ${formatParTime(briefing.parTimeSec)}`;
    } else {
        parEl?.classList.add('briefing-hidden');
    }

    const banner = overlay.querySelector('.briefing-banner');
    const img = document.getElementById('briefing-image') as HTMLImageElement | null;
    if (opts.imageUrl && img) {
        // A 404 on the thumbnail fallback is routine (not every map has a
        // processed thumb). Hide the banner, keep the briefing.
        img.addEventListener('error', () => banner?.classList.add('briefing-hidden'));
        img.src = opts.imageUrl;
    } else {
        banner?.classList.add('briefing-hidden');
    }

    const btn = document.getElementById('briefing-begin-btn') as HTMLButtonElement | null;
    btn?.addEventListener('click', () => {
        overlay.remove();
        opts.onBegin();
    });

    return {
        notifyReady(): void {
            if (btn) btn.disabled = false;
            setText('briefing-begin-label', 'Begin');
            overlay.classList.add('briefing-ready');
        },
        dismiss(): void {
            overlay.remove();
        },
    };
}
