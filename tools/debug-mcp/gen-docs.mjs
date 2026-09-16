#!/usr/bin/env node
// gen-docs.mjs — render docs/mcp-tools.md from the tool catalogue.
//
// WHY GENERATE IT. The MCP tool table in docs/debugging-tools.md is
// hand-written and has drifted from the schemas more than once (a tool gains a
// knob; the table does not). The schemas are the contract an agent actually
// sees, so the full reference is generated FROM them and cannot lie about
// names, types, enums, defaults or which arguments are required. The editorial
// layer — sections, blurbs, the cross-cutting rules — lives in tool-meta.js.
//
// `npm run docs` writes the file; `npm run docs -- --check` verifies it is up
// to date without writing (what a test asserts).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from './tools.js';
import { SECTIONS, CROSS_CUTTING } from './tool-meta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT_PATH = join(HERE, '..', '..', 'docs', 'mcp-tools.md');

/** Escape a cell for a markdown table: pipes break the row, newlines the row. */
function cell(text) {
    return String(text ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** `name` (type, enum, default) — one argument, rendered for a table cell. */
export function renderArg(name, spec = {}, required = false) {
    const bits = [];
    if (spec.type) bits.push(spec.type);
    if (Array.isArray(spec.enum)) bits.push(spec.enum.map((v) => `\`${v}\``).join('\\|'));
    if (spec.default !== undefined) bits.push(`default \`${JSON.stringify(spec.default)}\``);
    if (required) bits.push('**required**');
    return `\`${name}\`${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

export function renderTool(tool) {
    const props = tool.inputSchema?.properties || {};
    const required = new Set(tool.inputSchema?.required || []);
    const names = Object.keys(props);
    const args = names.length
        ? names.map((n) => `${renderArg(n, props[n], required.has(n))}${props[n]?.description ? ` — ${cell(props[n].description)}` : ''}`)
        : [];
    const lines = [`#### \`${tool.name}\``, '', cell(tool.description), ''];
    if (args.length) {
        lines.push('| Argument | Meaning |', '|---|---|');
        for (const n of names) {
            lines.push(`| ${renderArg(n, props[n], required.has(n))} | ${cell(props[n]?.description || '')} |`);
        }
        lines.push('');
    } else {
        lines.push('*No arguments.*', '');
    }
    return lines.join('\n');
}

export function renderDoc(tools = TOOLS) {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const placed = new Set(SECTIONS.flatMap((s) => s.tools));
    const orphans = tools.filter((t) => !placed.has(t.name)).map((t) => t.name);

    const out = [];
    out.push('<!-- GENERATED FILE — do not edit by hand.');
    out.push('     Source: tools/debug-mcp/tools.js (schemas) + tool-meta.js (sections and prose).');
    out.push('     Regenerate: cd tools/debug-mcp && npm run docs -->');
    out.push('');
    out.push('# spring-debug MCP tool reference');
    out.push('');
    out.push('Every tool the `spring-debug` MCP server (`tools/debug-mcp/server.js`) exposes, generated from');
    out.push('the schemas themselves so the names, types, defaults and required fields cannot drift from what');
    out.push('a caller actually gets. For setup, the SQLite/`SPRING_DB` rules and the hand-written narrative');
    out.push('sections, see [debugging-tools.md § Claude / MCP Integration](debugging-tools.md#claude--mcp-integration).');
    out.push('');
    out.push(`${tools.length} tools in ${SECTIONS.length} groups.`);
    out.push('');

    out.push('## Rules that apply to everything');
    out.push('');
    for (const rule of CROSS_CUTTING) {
        out.push(`**${rule.title}.** ${rule.body}`);
        out.push('');
    }

    out.push('## Index');
    out.push('');
    for (const section of SECTIONS) {
        const present = section.tools.filter((n) => byName.has(n));
        out.push(`- **${section.title}** — ${present.map((n) => `\`${n}\``).join(', ')}`);
    }
    out.push('');

    for (const section of SECTIONS) {
        const present = section.tools.filter((n) => byName.has(n));
        if (!present.length) continue;
        out.push(`## ${section.title}`);
        out.push('');
        out.push(section.blurb);
        out.push('');
        for (const name of present) out.push(renderTool(byName.get(name)));
    }

    if (orphans.length) {
        out.push('## Ungrouped');
        out.push('');
        out.push('These tools are not placed in any section of `tool-meta.js` — that is a bug in the map, not in the tools.');
        out.push('');
        for (const name of orphans) out.push(renderTool(byName.get(name)));
    }

    return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function main() {
    const wanted = renderDoc();
    if (process.argv.includes('--check')) {
        let current = '';
        try { current = readFileSync(OUT_PATH, 'utf8'); } catch { /* missing */ }
        if (current === wanted) { console.log(`docs/mcp-tools.md is up to date (${TOOLS.length} tools).`); return; }
        console.error('docs/mcp-tools.md is STALE — run `npm run docs` in tools/debug-mcp.');
        process.exit(1);
    }
    writeFileSync(OUT_PATH, wanted);
    console.log(`wrote ${OUT_PATH} (${TOOLS.length} tools, ${SECTIONS.length} sections).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
