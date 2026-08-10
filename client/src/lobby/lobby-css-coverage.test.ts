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

/// The declaration block of the first rule whose selector list names `cls`.
function ruleFor(cls: string): string {
    for (const m of CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selectors = m[1].split(',').map(s => s.trim());
        if (selectors.some(s => new RegExp(`\\.${cls}$`).test(s))) return m[2];
    }
    return '';
}
