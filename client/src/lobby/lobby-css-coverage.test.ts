/**
 * lobby-css-coverage.test.ts — regression for PLAN-endtoend.md D61.
 *
 * D61 was one AI-row `<select>` that painted native white against the dark
 * room card. The defect is not the element, it is the seam: the markup lives
 * in `lobby-ui.ts` / `ui/lobby/**.html` and the styling lives in
 * `ui/lobby/lobby.css`, so a control can be added, rendered, asserted on by a
 * DOM test and shipped without ever acquiring a rule. A DOM assertion cannot
 * see that (`.ai-profile-select` had six green tests around it).
 *
 * So this file asserts the seam rather than the two selectors: every class a
 * lobby `<select>` is rendered with must be named somewhere in `lobby.css`.
 * `.ai-team-select` and `.ai-profile-select` both fail it without the fix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const LOBBY_SRC = join(__dirname, '..', 'ui', 'lobby');
const CSS = readFileSync(join(LOBBY_SRC, 'lobby.css'), 'utf8');

/// Every file that can emit lobby markup: the templates under `ui/lobby/`
/// and the TypeScript that builds rows as template literals.
function markupSources(): { name: string, text: string }[] {
    const out: { name: string, text: string }[] = [];
    const walk = (dir: string) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, ent.name);
            if (ent.isDirectory()) walk(p);
            else if (ent.name.endsWith('.html')) out.push({ name: p, text: readFileSync(p, 'utf8') });
        }
    };
    walk(LOBBY_SRC);
    for (const ent of readdirSync(__dirname)) {
        if (ent.endsWith('.ts') && !ent.endsWith('.test.ts')) {
            out.push({ name: ent, text: readFileSync(join(__dirname, ent), 'utf8') });
        }
    }
    return out;
}

/// `<select class="a b" ...>` → the classes, with the file that renders it.
function renderedSelectClasses(): { cls: string, where: string }[] {
    const found: { cls: string, where: string }[] = [];
    for (const { name, text } of markupSources()) {
        for (const m of text.matchAll(/<select\b[^>]*?\sclass="([^"{]+)"/g)) {
            for (const cls of m[1].trim().split(/\s+/)) found.push({ cls, where: name });
        }
    }
    return found;
}

describe('lobby.css covers the controls lobby markup renders', () => {
    it('finds the selects it is meant to be checking', () => {
        // A guard on the guard: if the markup ever stops matching the regex
        // (a class moved into a variable, say) this test would pass by
        // finding nothing at all.
        const classes = new Set(renderedSelectClasses().map(s => s.cls));
        expect(classes.has('team-select')).toBe(true);
        expect(classes.has('ai-profile-select')).toBe(true);
        expect(classes.size).toBeGreaterThanOrEqual(4);
    });

    it('styles every class a rendered <select> carries', () => {
        const unstyled = renderedSelectClasses()
            .filter(s => !new RegExp(`\\.${s.cls}\\b`).test(CSS))
            .map(s => `${s.cls} (rendered by ${s.where})`);
        expect(unstyled).toEqual([]);
    });

    it('gives the AI row the same treatment as the player row', () => {
        // The visible symptom, pinned directly: a select with no `background`
        // paints the browser's white, which is what made D61 read as
        // "belongs to a different application".
        for (const cls of ['team-select', 'startpos-select', 'ai-team-select', 'ai-profile-select']) {
            const rule = ruleFor(cls);
            expect(rule, `no rule block for .${cls}`).not.toBe('');
            expect(rule, `.${cls} has no background`).toMatch(/background:/);
            expect(rule, `.${cls} has no colour`).toMatch(/color:/);
        }
    });

    it('styles the war card the browser renders (task 6)', () => {
        // The same seam, one template later. Buttons are excluded on purpose
        // — lobby.css styles the bare `button` element, so an unstyled button
        // class is not the D61 defect — but a war card's own layout classes
        // have no such fallback: with no rule, `.war-actions` is a block of
        // stacked full-width buttons in the middle of the card.
        const html = readFileSync(
            join(LOBBY_SRC, 'browser', 'war-entry.html'), 'utf8');
        const classes = new Set<string>();
        for (const m of html.matchAll(/<(\w+)\b[^>]*?\sclass="([^"{]+)"/g)) {
            if (m[1] === 'button') continue;
            for (const cls of m[2].trim().split(/\s+/)) classes.add(cls);
        }
        expect(classes.has('war-actions')).toBe(true);
        const unstyled = [...classes]
            .filter(c => !new RegExp(`\\.${c}\\b`).test(CSS));
        expect(unstyled).toEqual([]);
    });

    it('styles the friends panel, including the classes built from data (task 9a)', () => {
        // The same seam again, and here it is worse than a template: the row
        // classes are assembled from the wire's own words
        // (`friend-${edge}`, `friend-presence-${presence}`), so no regex over
        // the markup can find them and a missing rule is invisible to every
        // DOM assertion. They are enumerated against the two server enums —
        // FriendEdgeToString and PresenceStateToString — so a new state on the
        // server fails here rather than rendering unstyled.
        const html = readFileSync(join(LOBBY_SRC, 'browser', 'browser.html'), 'utf8');
        const panel = html.slice(html.indexOf('id="friends-panel"'));
        const classes = new Set<string>();
        for (const m of panel.matchAll(/<(\w+)\b[^>]*?\sclass="([^"{]+)"/g)) {
            if (m[1] === 'button') continue;
            for (const cls of m[2].trim().split(/\s+/)) classes.add(cls);
        }
        expect(classes.has('friends-list')).toBe(true);
        for (const cls of [
            'friend-entry', 'friend-main', 'friend-name', 'friend-faction',
            'friend-actions', 'friend-msg', 'friend-msg-error', 'friend-msg-warn',
            'friend-incoming', 'friend-outgoing', 'friend-mutual', 'friend-none',
            'friend-presence',
            'friend-presence-fighting', 'friend-presence-staging',
            'friend-presence-online', 'friend-presence-offline',
            'friend-presence-unknown',
            'war-friends',
        ]) classes.add(cls);
        const unstyled = [...classes]
            .filter(c => !new RegExp(`\\.${c}\\b`).test(CSS));
        expect(unstyled).toEqual([]);

        // "Named in the file" is too weak for the three classes that carry the
        // panel's meaning: `.war-friends` is also named by a layout rule, so
        // deleting its colour rule alone left the check green. Each of these
        // has to own the declaration it exists for.
        // Every block, not the first: `.war-friends` is named by a layout rule
        // (`.war-entry .war-friends`) as well as its own, and `ruleFor` would
        // hand back whichever comes first in the file.
        expect(allRulesFor('war-friends'), '.war-friends has no colour').toMatch(/color:/);
        expect(allRulesFor('friend-entry'), '.friend-entry has no background')
            .toMatch(/background:/);
        expect(allRulesFor('friend-presence-fighting'),
               'a fighting friend is not marked').toMatch(/color:/);
    });

    it('stops the war card inheriting the room card"s join-button placement', () => {
        // `.join-btn` is pinned `grid-row: 1 / -1` for the room card, where it
        // is a grid item. In a war card it is a flex child of `.war-actions`,
        // and the inherited rule stretched it over the whole card — found by
        // rendering it, not by reading it. The reset is what stops that, so
        // removing it is a failure here rather than a two-inch-tall button.
        expect(ruleFor('war-entry .join-btn')).toMatch(/grid-row:\s*auto/);
    });

    it('lets a player row wrap instead of overflowing its card', () => {
        // Found while fixing D61, on the same row: a `<select>`'s min-content
        // width is its widest option, so three dropdowns could not shrink to
        // fit and the AI row pushed its status text and remove button outside
        // the room card. Nothing here can measure layout — this pins the two
        // declarations that stop it, so removing either is a test failure
        // rather than a control rendered on the page background.
        expect(ruleFor('player-row')).toMatch(/flex-wrap:\s*wrap/);
        expect(ruleFor('ai-profile-select')).toMatch(/min-width:\s*0/);
    });
});

/// Every declaration block whose selector list names `cls`, joined. Use this
/// for a class that legitimately carries more than one rule — a layout one and
/// a paint one — where the first block alone answers the wrong question.
function allRulesFor(cls: string): string {
    const blocks: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selectors = m[1].split(',').map(s => s.trim());
        if (selectors.some(s => new RegExp(`\\.${cls}$`).test(s))) blocks.push(m[2]);
    }
    return blocks.join(' ');
}

/// The declaration block of the first rule whose selector list names `cls`.
function ruleFor(cls: string): string {
    for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selectors = m[1].split(',').map(s => s.trim());
        if (selectors.some(s => new RegExp(`\\.${cls}$`).test(s))) return m[2];
    }
    return '';
}
