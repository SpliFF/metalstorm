// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { showBriefingSplash, formatParTime, storyParagraphs } from './briefing.js';
import type { GameTemplates } from '../game/loader.js';
import type { ScenarioBriefing } from '../../lobby/scenario-picker.js';
import briefingHtml from './briefing.html?raw';
import briefingCss from './briefing.css?raw';

// S2 — the scenario briefing splash. Three properties are load-bearing and all
// three are pinned here:
//
//   1. Begin arms ONLY on notifyReady(). A splash that lets the player in
//      before the battlefield exists is worse than no splash.
//   2. Authored prose reaches the DOM as TEXT. Briefings can come from the
//      generated_scenarios table, so a story is untrusted input.
//   3. Every field is optional and an absent one collapses its row rather
//      than leaving a labelled void.

const templates = { briefingHtml, briefingCss } as unknown as GameTemplates;

const FULL: ScenarioBriefing = {
    title: 'The Standoff',
    subtitle: 'Scorched Crossing',
    story: 'First paragraph.\n\nSecond paragraph.',
    tips: ['Hold the middle.', 'Artillery outranges tanks.'],
    image: 'scenarios/img/war.jpg',
    parTimeSec: 900,
};

const overlay = () => document.getElementById('briefing-overlay');

describe('formatParTime', () => {
    it('renders minutes and two-digit seconds', () => {
        expect(formatParTime(900)).toBe('15:00');
        expect(formatParTime(615)).toBe('10:15');
        expect(formatParTime(65)).toBe('1:05');
    });

    it('keeps long par times in minutes rather than rolling to hours', () => {
        // The player compares this against a match clock, which counts minutes.
        expect(formatParTime(5400)).toBe('90:00');
    });
});

describe('storyParagraphs', () => {
    it('splits on blank lines and drops the empties', () => {
        expect(storyParagraphs('a\n\nb')).toEqual(['a', 'b']);
        expect(storyParagraphs('a\n\n\n   \n\nb')).toEqual(['a', 'b']);
    });

    it('keeps a single-line break inside one paragraph', () => {
        // Authored [[long strings]] wrap; only a BLANK line is a break.
        expect(storyParagraphs('a\nb')).toEqual(['a\nb']);
    });

    it('returns nothing for an empty story', () => {
        expect(storyParagraphs('')).toEqual([]);
        expect(storyParagraphs('   \n  ')).toEqual([]);
    });
});

describe('showBriefingSplash', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        document.head.innerHTML = '';
    });

    it('renders every authored field', () => {
        showBriefingSplash(templates, FULL, {
            fallbackTitle: 'Unused', imageUrl: '/api/x.jpg', onBegin: () => {},
        });

        expect(document.getElementById('briefing-title')?.textContent).toBe('The Standoff');
        expect(document.getElementById('briefing-subtitle')?.textContent).toBe('Scorched Crossing');
        const paras = document.querySelectorAll('#briefing-story p');
        expect(paras.length).toBe(2);
        expect(paras[0].textContent).toBe('First paragraph.');
        expect(paras[1].textContent).toBe('Second paragraph.');
        const tips = document.querySelectorAll('#briefing-tips li');
        expect(tips.length).toBe(2);
        expect(tips[1].textContent).toBe('Artillery outranges tanks.');
        expect(document.getElementById('briefing-partime')?.textContent).toBe('Par time 15:00');
        expect((document.getElementById('briefing-image') as HTMLImageElement).src)
            .toContain('/api/x.jpg');
    });

    it('falls back to the scenario display name when no title is authored', () => {
        showBriefingSplash(templates, { tips: [], story: 'x' }, {
            fallbackTitle: 'Scorched Crossing — The Standoff', imageUrl: null, onBegin: () => {},
        });
        expect(document.getElementById('briefing-title')?.textContent)
            .toBe('Scorched Crossing — The Standoff');
    });

    it('collapses the tips, par-time and banner rows when they are absent', () => {
        showBriefingSplash(templates, { story: 'Only a story.', tips: [] }, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => {},
        });
        expect(document.getElementById('briefing-tips-wrap')?.classList.contains('briefing-hidden'))
            .toBe(true);
        expect(document.getElementById('briefing-partime')?.classList.contains('briefing-hidden'))
            .toBe(true);
        expect(document.querySelector('.briefing-banner')?.classList.contains('briefing-hidden'))
            .toBe(true);
    });

    it('keeps Begin disabled until the game reports ready', () => {
        const handle = showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => {},
        });
        const btn = document.getElementById('briefing-begin-btn') as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
        expect(document.getElementById('briefing-begin-label')?.textContent)
            .toBe('Preparing battlefield…');
        expect(overlay()?.classList.contains('briefing-ready')).toBe(false);

        handle.notifyReady();
        expect(btn.disabled).toBe(false);
        expect(document.getElementById('briefing-begin-label')?.textContent).toBe('Begin');
        expect(overlay()?.classList.contains('briefing-ready')).toBe(true);
    });

    it('removes the overlay and calls onBegin on click', () => {
        let began = 0;
        const handle = showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => { began++; },
        });
        handle.notifyReady();
        (document.getElementById('briefing-begin-btn') as HTMLButtonElement).click();
        expect(began).toBe(1);
        expect(overlay()).toBeNull();
    });

    it('dismiss() tears it down without calling onBegin', () => {
        // dismiss() is a teardown (quit, game over, a new boot), not a player
        // decision — firing onBegin from it would run the caller's
        // "player is in" path on a session that is going away.
        let began = 0;
        const handle = showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => { began++; },
        });
        handle.dismiss();
        expect(overlay()).toBeNull();
        expect(began).toBe(0);
    });

    it('is idempotent — a second mount replaces the first', () => {
        showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => {},
        });
        showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => {},
        });
        expect(document.querySelectorAll('#briefing-overlay').length).toBe(1);
        // And the replacement is fully rendered, not a leftover shell.
        expect(document.querySelectorAll('#briefing-story p').length).toBe(2);
    });

    it('renders markup in authored prose as text, never as elements', () => {
        // The XSS pin. Briefing content can originate in generated_scenarios,
        // so it is data. If this ever regresses to innerHTML the img below
        // becomes a real element and this test says so.
        const hostile: ScenarioBriefing = {
            title: '<b>bold</b>',
            story: 'Watch out <img src=x onerror="globalThis.__pwned = 1">',
            tips: ['<script>globalThis.__pwned = 2</script>'],
        };
        showBriefingSplash(templates, hostile, {
            fallbackTitle: 'War', imageUrl: null, onBegin: () => {},
        });

        const panel = overlay()!;
        // The only <img> in the tree is the banner from the static template.
        expect(panel.querySelectorAll('img').length).toBe(1);
        expect(panel.querySelector('#briefing-story img')).toBeNull();
        expect(panel.querySelectorAll('script').length).toBe(0);
        expect(panel.querySelector('#briefing-title b')).toBeNull();
        expect(document.getElementById('briefing-title')?.textContent).toBe('<b>bold</b>');
        expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
    });

    it('hides the banner when the image fails to load', () => {
        // A map with no processed thumbnail is routine; a broken-image icon
        // over a story is not.
        showBriefingSplash(templates, FULL, {
            fallbackTitle: 'War', imageUrl: '/api/maps/thumb/nope', onBegin: () => {},
        });
        const banner = document.querySelector('.briefing-banner')!;
        expect(banner.classList.contains('briefing-hidden')).toBe(false);
        document.getElementById('briefing-image')!.dispatchEvent(new Event('error'));
        expect(banner.classList.contains('briefing-hidden')).toBe(true);
    });
});
