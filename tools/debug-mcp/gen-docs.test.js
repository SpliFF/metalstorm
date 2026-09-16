import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS } from './tools.js';
import { SECTIONS, CROSS_CUTTING } from './tool-meta.js';
import { renderDoc, renderArg, renderTool, OUT_PATH } from './gen-docs.mjs';

test('SECTIONS is a total partition of TOOLS — no orphan, no duplicate, no ghost', () => {
    const placed = SECTIONS.flatMap((s) => s.tools);
    const names = new Set(TOOLS.map((t) => t.name));
    const orphans = [...names].filter((n) => !placed.includes(n));
    assert.deepEqual(orphans, [], `unplaced tools (add them to tool-meta.js): ${orphans.join(', ')}`);
    const ghosts = placed.filter((n) => !names.has(n));
    assert.deepEqual(ghosts, [], `tool-meta.js names tools that do not exist: ${ghosts.join(', ')}`);
    const dupes = placed.filter((n, i) => placed.indexOf(n) !== i);
    assert.deepEqual(dupes, [], `listed in two sections: ${dupes.join(', ')}`);
});

test('docs/mcp-tools.md is up to date (run `npm run docs` in tools/debug-mcp)', () => {
    const current = readFileSync(OUT_PATH, 'utf8');
    assert.equal(current, renderDoc(), 'docs/mcp-tools.md is stale — regenerate it');
});

test('renderArg spells out type, enum, default and required', () => {
    assert.equal(renderArg('roomId', { type: 'number' }), '`roomId` (number)');
    assert.equal(renderArg('poi', { type: 'string' }, true), '`poi` (string, **required**)');
    assert.equal(
        renderArg('detail', { type: 'string', enum: ['clock', 'all'], default: 'clock' }),
        '`detail` (string, `clock`\\|`all`, default `"clock"`)',
    );
    assert.equal(renderArg('bare', {}), '`bare`');
});

test('a pipe or a newline in a description cannot break the table row', () => {
    const md = renderTool({
        name: 't', description: 'one\ntwo',
        inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'x | y' } } },
    });
    const row = md.split('\n').find((l) => l.startsWith('| `a`'));
    assert.equal(row.split(/(?<!\\)\|/).length - 1, 3, 'exactly the two cell separators plus the trailing one');
    assert.ok(md.includes('one two'), 'a newline in the description is folded, not emitted raw');
});

test('a tool with no arguments says so instead of rendering an empty table', () => {
    const md = renderTool({ name: 'list_sessions', description: 'd', inputSchema: { type: 'object', properties: {} } });
    assert.match(md, /\*No arguments\.\*/);
    assert.ok(!md.includes('| Argument |'));
});

test('the generated doc carries the do-not-edit banner and every tool', () => {
    const md = renderDoc();
    assert.match(md, /^<!-- GENERATED FILE/);
    for (const t of TOOLS) assert.ok(md.includes(`#### \`${t.name}\``), `${t.name} is missing from the doc`);
    for (const rule of CROSS_CUTTING) assert.ok(md.includes(rule.title), `${rule.title} is missing`);
});

test('the world/ai/nl tools are documented with their traps, not just their names', () => {
    const md = renderDoc();
    for (const needle of [
        'single-threaded',              // the relay deadlock
        'revealTokens',                 // token redaction
        'SPRING_MCP_HTTP_TIMEOUT_MS',   // deadlines
        'not a port',                   // roomId semantics
        'world_commit',
        'nl_command',
        'ai_guidance',
    ]) assert.ok(md.includes(needle), `${needle} should be in the reference`);
});
