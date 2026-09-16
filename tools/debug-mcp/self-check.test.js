import test from 'node:test';
import assert from 'node:assert/strict';
import {
    runSelfCheck, argReads, readsDynamically, balancedBlock, caseBlock, handlerBlock, HELPERS,
} from './self-check.mjs';

test('the catalogue is clean: every tool reads what it declares, and declares what it reads', () => {
    const { errors, warnings, rows } = runSelfCheck();
    assert.deepEqual(errors, [], errors.join('\n'));
    assert.deepEqual(warnings, [], warnings.join('\n'));
    assert.ok(rows.length > 50, `only ${rows.length} tools checked — did the scan stop finding handlers?`);
});

test('every tool resolves to a handler (the check itself is not vacuous)', () => {
    const { rows } = runSelfCheck();
    for (const r of rows) assert.ok(r.reads >= 0 && r.where, `${r.tool} has no source`);
    assert.ok(rows.some((r) => r.where === 'world-tools.js'), 'the module-hosted tools must be reached');
    assert.ok(rows.some((r) => r.where === 'ai-tools.js'));
    assert.ok(rows.some((r) => r.where === 'nl-tools.js'));
});

test('argReads sees dotted reads and destructuring, under any parameter name', () => {
    assert.deepEqual([...argReads('if (args.a) return args.b_1; args .c')].sort(), ['a', 'b_1', 'c']);
    assert.deepEqual([...argReads('const { x, y: z, w = 1 } = args;')].sort(), ['w', 'x', 'y']);
    assert.deepEqual([...argReads('g.op === "stance" ? g.value : null', 'g')].sort(), ['op', 'value']);
    assert.ok(!argReads('args.__revealed').has('__revealed'), 'internal plumbing is not an argument');
});

test('readsDynamically spots the schema-derived forward that a text scan cannot follow', () => {
    assert.equal(readsDynamically('for (const k of knobs) body[k] = args[k];'), true);
    assert.equal(readsDynamically('args.seed'), false);
});

test('the regex-literal trap: a backtick INSIDE a regex must not swallow the rest of the switch', () => {
    // This is evaluate_widget_lua's real shape. Read naively, the backtick in
    // /`/g opens a template literal and the block runs into the next case.
    const src = "x { const s = args.code.replace(/`/g, '\\\\`'); } case 'other': { args.stowaway; }";
    const block = balancedBlock(src, 0);
    assert.ok(block.includes('args.code'));
    assert.ok(!block.includes('stowaway'), 'the block must END at its own closing brace');
});

test('balancedBlock ignores braces in strings, templates and comments', () => {
    assert.equal(balancedBlock('a { /* } */ b } tail', 0), '{ /* } */ b }');
    assert.equal(balancedBlock('a { "}" } tail', 0), '{ "}" }');
    assert.equal(balancedBlock('a { `${x}}` } tail', 0), '{ `${x}}` }');
    assert.equal(balancedBlock('a { // }\n }', 0), '{ // }\n }');
    assert.equal(balancedBlock('no brace here', 0), '');
});

test('a case body shared by several labels reports all of them, from either label', () => {
    const src = "switch (n) { case 'a': case 'b': { args.z; } case 'c': { args.q; } }";
    assert.deepEqual(caseBlock(src, 'a').names, ['a', 'b']);
    assert.deepEqual(caseBlock(src, 'b').names, ['a', 'b']);
    assert.deepEqual(caseBlock(src, 'c').names, ['c']);
    assert.equal(caseBlock(src, 'missing'), null);
});

test('handlerBlock finds a module-hosted handler by name', () => {
    const src = 'export const h = { async world_x(args, io) { return args.poi; } };';
    assert.ok(handlerBlock(src, 'world_x').block.includes('args.poi'));
    assert.equal(handlerBlock(src, 'world_y'), null);
});

test('the hand-maintained HELPERS map is non-empty and every file really reads its param', () => {
    assert.ok(HELPERS.length >= 3);
    // runSelfCheck turns an empty scan into an error; the clean run above is
    // therefore also the assertion that none of these files went stale.
    for (const h of HELPERS) assert.ok(h.file && h.param && h.tools.length);
});
