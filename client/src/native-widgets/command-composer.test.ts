/**
 * command-composer.test.ts — Basic tests for command-composer widget
 *
 * Note: Full DOM interaction tests would require jsdom, which is not installed.
 * These tests verify the widget's interface contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Source with comments and template/quoted literals blanked out, so a
 * `alert()` mentioned in prose or inside a message string never trips the
 * modal-dialog guard below. Only real call sites survive.
 */
function rawSource(relPath: string): string {
    return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');
}

function callableSource(relPath: string): string {
    return rawSource(relPath)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
        .replace(/\/\/[^\n]*/g, ' ')          // line comments
        .replace(/`(?:\\.|[^`\\])*`/g, '``')  // template literals
        .replace(/'(?:\\.|[^'\\])*'/g, "''")  // single-quoted
        .replace(/"(?:\\.|[^"\\])*"/g, '""'); // double-quoted
}

/**
 * Regression for PLAN-endtoend D54 (fire 26).
 *
 * Committing a directive is the game's primary command verb, and every outcome
 * of it — success included — used to raise a native `alert()`. Measured live on
 * the player path: five directives issued through the composer left five
 * blocking browser modals, each of which freezes the render loop and must be
 * dismissed before the next order can be composed.
 *
 * Two modals survive on purpose, and are pinned here so a third cannot creep
 * back in unnoticed: `prompt()` for a preset's *name* (genuine free text, not
 * an outcome readout) and `confirm()` for preset *deletion* (a guard on a
 * destructive action, which is a different thing from acknowledging success).
 * Neither is on the commit path.
 *
 * The guard is at source level on purpose: jsdom is not installed here (see
 * the note above), so there is no way to drive handleCommit and assert on
 * `window.alert` — but "no modal dialog on the command path" is exactly the
 * invariant, and it is checkable directly.
 */
describe('command-composer — no blocking modal on the command path (D54)', () => {
    it('never calls alert()', () => {
        expect(callableSource('./command-composer.js').match(/(?<![.\w])alert\s*\(/g)).toBeNull();
    });

    it('keeps exactly the two deliberate preset-only modals', () => {
        const src = callableSource('./command-composer.js');

        expect(src.match(/(?<![.\w])confirm\s*\(/g)).toHaveLength(1);
        expect(src.match(/(?<![.\w])prompt\s*\(/g)).toHaveLength(1);
    });

    it('reports commit outcomes through the inline status readout instead', () => {
        const src = callableSource('./command-composer.js');

        // The replacement exists, and the commit path routes both the success
        // and the refusal branches through it.
        expect(src).toMatch(/function setStatus\s*\(/);
        expect(src.match(/setStatus\s*\(/g)!.length).toBeGreaterThanOrEqual(6);

        // The readout is actually rendered (class name lives in markup, so
        // this one reads the unblanked source).
        expect(rawSource('./command-composer.js')).toMatch(/class="composer-status/);
    });
});

describe('command-composer widget', () => {
    it('should export widget interface', async () => {
        // Dynamically import the widget
        const module = await import('./command-composer.js');
        const widget = module.default;

        expect(widget).toBeDefined();
        expect(widget.id).toBe('command-composer');
        expect(typeof widget.init).toBe('function');
        expect(typeof widget.dispose).toBe('function');
    });

    it('should validate widget follows contract', async () => {
        const module = await import('./command-composer.js');
        const widget = module.default;

        // Widget must have id, init, dispose
        expect(widget.id).toBeDefined();
        expect(widget.init).toBeDefined();
        expect(widget.dispose).toBeDefined();

        // Verify they are functions
        expect(typeof widget.init).toBe('function');
        expect(typeof widget.dispose).toBe('function');

        // Verify id is a string
        expect(typeof widget.id).toBe('string');
    });
});

/**
 * PLAN-endtoend.md D51 — the target menu must not invent its own offer.
 *
 * The widget used to list "🔍 Search by name…" unconditionally, so five of the
 * eleven verbs offered a named place the compile table refuses. The fix is that
 * the offer is *derived* (`targetMenuOptions`), and this guard is at source
 * level for the same reason as the modal guard above: jsdom is not installed
 * here, so `renderTargetMenu` cannot be driven — but "the menu is derived, not
 * hand-written" is exactly the invariant, and the shape logic it delegates to
 * is unit-tested in compile-table.test.ts.
 */
describe('command-composer — the target offer is derived from the compile table (D51)', () => {
    it('builds the target menu from targetMenuOptions', () => {
        const src = callableSource('./command-composer.js');

        expect(src).toMatch(/targetMenuOptions\s*\(\s*state\.verb\s*\)/);
        // The old unconditional listing is gone: every `target-search-option`
        // in the markup now sits on the enabled branch of that mapping.
        expect(rawSource('./command-composer.js').match(/target-search-option/g))
            .toHaveLength(2);   // one emitted, one queried for its click handler
        expect(rawSource('./command-composer.js')).toMatch(/opt\.enabled\s*$|opt\.enabled\s*\n/m);
    });

    it('shows the refusal reason instead of hiding an unusable option', () => {
        const src = rawSource('./command-composer.js');

        expect(src).toMatch(/nui-menu__item--disabled.*Search by name/);
        expect(src).toMatch(/escapeHtml\(opt\.reason\)/);
    });

    it('warns at accelerator fill-time when the resolved place cannot compile', () => {
        // rawSource: the warning is interpolated into a template literal, which
        // callableSource blanks by design.
        const src = rawSource('./command-composer.js');

        expect(src).toMatch(/explainShapeMismatch\s*\(\s*state\.verb\s*,\s*state\.target\.shape\s*\)/);
        expect(src).toMatch(/getAcceptedTargetShapes\s*\(\s*state\.verb\s*\)\s*\.includes/);
    });
});
