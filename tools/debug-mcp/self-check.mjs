#!/usr/bin/env node
// self-check.mjs — does every tool READ what its schema DECLARES?
//
// WHY. Two failures, both found in the 2026-09-10 review, both invisible to
// every other check in this tree:
//
//   - READ BUT NOT DECLARED. `spawn_at_camera`, `browser_test` and
//     `evaluate_widget_lua` read `args.roomId` / `args.clientId`, which their
//     schemas did not list. The field worked if you knew to pass it, was
//     undiscoverable if you did not, and — worse — `tool-args.js`'s near-miss
//     check could not protect a name it had never heard of, so `roomID` was
//     silently ignored.
//   - DECLARED BUT NOT READ. `generate_scenario` declared `works`, `harbour`,
//     `shanty`, `coverage` and `player`; the handler forwarded a hand-kept
//     list that predated all five. They validated, and then went nowhere. This
//     is the "whitelist emitter drops new keys" trap, and it fails silently and
//     plausibly — exactly the shape a human reviewer skims past.
//
// Both are a diff between two lists that live in different files, so this
// script computes that diff. It is deliberately a TEXT scan, not a parse: the
// thing being checked is "does the string `args.foo` appear in the code that
// serves tool foo", and an AST would add a dependency to answer the same
// question. The cost is that it cannot see through a helper that takes
// `args` under another name — hence HELPERS below, which is maintained by
// hand and asserted non-empty.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOLS } from './tools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, f), 'utf8');

/**
 * Code that receives a tool's argument object whole, under the given parameter
 * name. Hand-maintained (a text scan cannot follow a value across a call) and
 * asserted non-empty below, so a rename fails loudly instead of quietly
 * dropping a file from the check.
 */
export const HELPERS = [
    { file: 'capture-subject.js', param: 'args', tools: ['capture_subject'] },
    { file: 'capture-sequence.js', param: 'args', tools: ['capture_sequence', 'order_and_film'] },
    { file: 'guidance-wire.js', param: 'g', tools: ['ai_guidance'] },
];

/**
 * Names a handler reads ON PURPOSE without declaring them, with the reason.
 * Each one is a wrong-shape detector: the field is not an argument, it is a
 * mistake the handler recognises so it can say what the right shape is.
 */
export const ALLOW_UNDECLARED = {
    capture_subject: { x: 'a "you passed x/z instead of `position`" detector, not an argument' },
};

/** Modules that host their own handlers (server.js dispatches to them). */
const HANDLER_MODULES = ['world-tools.js', 'ai-tools.js', 'nl-tools.js'];

/**
 * Names a handler may read without declaring: internal plumbing passed
 * between our own functions rather than supplied by an MCP caller.
 */
const INTERNAL = new Set(['__revealed']);

/** Every `<param>.<name>` and `{a, b} = <param>` name in a chunk of source. */
export function argReads(source, param = 'args') {
    const names = new Set();
    for (const m of source.matchAll(new RegExp(`\\b${param}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g'))) names.add(m[1]);
    for (const m of source.matchAll(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${param}\\b`, 'g'))) {
        for (const part of m[1].split(',')) {
            const name = part.split(':')[0].split('=')[0].trim();
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    for (const n of INTERNAL) names.delete(n);
    return names;
}

/** Does the code read `args[expr]` — a computed forward this scan cannot follow? */
export function readsDynamically(source, param = 'args') {
    return new RegExp(`\\b${param}\\s*\\[`).test(source);
}

/**
 * Slice out a brace-balanced block starting at the `{` at or after `from`.
 *
 * Skips strings, template literals, comments AND regex literals. The last of
 * those is not pedantry: `evaluate_widget_lua`'s body contains
 * `args.code.replace(/`/g, …)`, whose regex holds a BACKTICK. Read naively
 * that opens a template literal, the scanner runs past the end of the case,
 * and the tool is then charged with reading the *next* tool's arguments
 * (`target`, `timeoutMs`) — a false positive that looks exactly like the real
 * bug this script hunts.
 */
export function balancedBlock(source, from) {
    const open = source.indexOf('{', from);
    if (open < 0) return '';
    // A `/` starts a regex only where a value may begin; after an identifier,
    // a `)` or a `]` it is division.
    const REGEX_OK_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', null]);
    let depth = 0;
    let prev = null;
    for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
        if (c === '/' && source[i + 1] === '*') { const e = source.indexOf('*/', i); if (e < 0) break; i = e + 1; continue; }
        if (c === '/' && REGEX_OK_AFTER.has(prev)) {
            let inClass = false;
            for (i++; i < source.length; i++) {
                if (source[i] === '\\') { i++; continue; }
                if (source[i] === '[') inClass = true;
                else if (source[i] === ']') inClass = false;
                else if (source[i] === '/' && !inClass) break;
                else if (source[i] === '\n') break;      // not a regex after all
            }
            prev = '/';
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') {
            const quote = c;
            for (i++; i < source.length; i++) {
                if (source[i] === '\\') { i++; continue; }
                if (source[i] === quote) break;
            }
            prev = quote;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return source.slice(open, i + 1); }
        if (!/\s/.test(c)) prev = c;
    }
    return '';
}

/**
 * The `case '<tool>':` body in server.js's executeTool switch, and every tool
 * name sharing it. Several tools share one body (`case 'a': case 'b': { … }`),
 * and a shared body legitimately reads the union of their arguments — charging
 * each tool with the other's fields would be noise, not a finding.
 */
export function caseBlock(source, tool) {
    const re = new RegExp(`case\\s+'${tool}'\\s*:`, 'g');
    const m = re.exec(source);
    if (!m) return null;
    // Walk BACK over labels preceding this one, then forward over the rest.
    const names = [tool];
    const back = /case\s+'([^']+)'\s*:\s*$/;
    let head = source.slice(0, m.index);
    let bm;
    while ((bm = head.match(back))) { names.unshift(bm[1]); head = head.slice(0, head.length - bm[0].length); }
    let cursor = m.index + m[0].length;
    const fwd = /\s*case\s+'([^']+)'\s*:/y;
    fwd.lastIndex = cursor;
    let fm;
    while ((fm = fwd.exec(source))) { names.push(fm[1]); cursor = fwd.lastIndex; fwd.lastIndex = cursor; }
    const block = balancedBlock(source, cursor);
    return block ? { block, names } : null;
}

/** A module handler body: `async <tool>(args, io) { … }`. */
export function handlerBlock(source, tool) {
    const re = new RegExp(`(?:async\\s+)?${tool}\\s*\\(\\s*args\\s*,`, 'g');
    const m = re.exec(source);
    if (!m) return null;
    const block = balancedBlock(source, m.index + m[0].length);
    return block ? { block, names: [tool] } : null;
}

export function runSelfCheck() {
    const serverSrc = read('server.js');
    const moduleSrc = Object.fromEntries(HANDLER_MODULES.map((f) => [f, read(f)]));
    const helperReads = HELPERS.map((h) => ({ ...h, reads: argReads(read(h.file), h.param) }));
    const byName = new Map(TOOLS.map((t) => [t.name, t]));

    const errors = [];
    const warnings = [];
    const rows = [];

    for (const tool of TOOLS) {
        const props = Object.keys(tool.inputSchema?.properties || {});
        let found = caseBlock(serverSrc, tool.name);
        let where = 'server.js';
        if (!found) {
            for (const f of HANDLER_MODULES) {
                const b = handlerBlock(moduleSrc[f], tool.name);
                if (b) { found = b; where = f; break; }
            }
        }
        if (!found) {
            errors.push(`${tool.name}: no handler found — neither a \`case '${tool.name}':\` in server.js `
                + `nor a \`${tool.name}(args, io)\` in ${HANDLER_MODULES.join(' / ')}.`);
            continue;
        }

        const reads = argReads(found.block);
        let dynamic = readsDynamically(found.block);
        const helpers = [];
        for (const h of helperReads) {
            if (!h.tools.includes(tool.name)) continue;
            helpers.push(h.file);
            for (const n of h.reads) reads.add(n);
            if (readsDynamically(read(h.file), h.param)) dynamic = true;
        }

        // A body shared by several `case` labels reads the UNION of their
        // arguments; only a name NO sharer declares is drift.
        const declaredHere = new Set(props);
        const declaredAnywhere = new Set(
            found.names.flatMap((n) => Object.keys(byName.get(n)?.inputSchema?.properties || {})),
        );
        const allowed = ALLOW_UNDECLARED[tool.name] || {};

        const undeclared = [...reads]
            .filter((n) => !declaredAnywhere.has(n) && !(n in allowed))
            .sort();
        const unread = props.filter((n) => !reads.has(n)).sort();

        if (undeclared.length)
            errors.push(`${tool.name} (${[where, ...helpers].join(' + ')}) READS but does not DECLARE: `
                + `${undeclared.join(', ')} — a caller cannot discover them and tool-args.js cannot `
                + 'catch a typo in them.');
        if (unread.length && !dynamic)
            warnings.push(`${tool.name} (${[where, ...helpers].join(' + ')}) DECLARES but never reads: `
                + `${unread.join(', ')} — either the handler drops them (the whitelist-emitter trap) `
                + 'or the schema is stale.');
        rows.push({
            tool: tool.name, where, helpers, sharedWith: found.names.filter((n) => n !== tool.name),
            declared: declaredHere.size, reads: reads.size, dynamic, undeclared,
            unread: dynamic ? [] : unread,
        });
    }

    // The HELPERS map is hand-maintained; an empty scan means a file was
    // renamed, or its parameter was, and this script quietly stopped checking.
    for (const h of helperReads)
        if (!h.reads.size)
            errors.push(`HELPERS lists ${h.file} (param \`${h.param}\`), but no \`${h.param}.<name>\` `
                + 'reads were found in it — stale map?');

    return { errors, warnings, rows };
}

function main() {
    const { errors, warnings, rows } = runSelfCheck();
    for (const w of warnings) console.log(`WARN  ${w}`);
    for (const e of errors) console.log(`ERROR ${e}`);
    console.log(`\n${rows.length} tools checked · ${errors.length} error(s) · ${warnings.length} warning(s)`);
    process.exit(errors.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
