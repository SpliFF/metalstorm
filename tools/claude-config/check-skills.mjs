// check-skills.mjs — the mechanical drift check behind check-skills.sh.
//
// WHY THIS EXISTS
//
// The 2026-09-10 skills review (docs/reviews/2026-09-10/skills.md) found that
// every serious defect in the skill tree was the same defect: a skill naming
// something the code does not have. A removed transport (`POST /api/rtc/offer`
// after WebRTC came out in GW7), a tool argument that was renamed, a file that
// moved, a placeholder tool name that was never replaced with the shipped one.
// None of it is catchable by reading — the prose stays plausible forever — and
// all of it is catchable by grep. So: grep.
//
// The check is deliberately NAME-level, not behaviour-level. It answers "does
// this identifier exist in the code?" and nothing else. It cannot tell you that
// a skill describes a tool's behaviour wrongly; it can tell you the skill is
// describing a tool that is not there, which is the failure that actually
// happened, five times, in one review.
//
// WHAT IT RESOLVES AGAINST (all harvested from code at run time — never a
// second hand-maintained list, which would be one more thing to drift):
//
//   tools      tools/debug-mcp/tools.js           — the MCP tool catalogue
//   args       the same, per tool inputSchema     — argument names
//   verbs      rts/Server/LuaExecEngine.cpp       — `exec_lua` server verbs
//   tables     rts/**                             — CREATE TABLE names
//   harness    client/src/core/test-harness.ts    — `window.test.*` methods
//   routes     docs/api.md + rts/lobby_main.cpp   — HTTP routes
//   paths      the filesystem                     — relative file references
//
// ...plus `check-skills.allow` for tokens that are legitimately not any of
// those: tools belonging to OTHER MCP servers (chrome-devtools), result
// strings, and identifiers a skill names precisely to say they do NOT exist.
// The allowlist is the escape hatch and it is reviewable; keep it short.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOW_FILE = join(REPO, 'tools', 'claude-config', 'check-skills.allow');

const findings = [];
const report = (file, line, rule, msg) =>
    findings.push({ file: relative(REPO, file), line, rule, msg });

// ─── Vocabularies ───────────────────────────────────────────────────────────

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const { TOOLS } = await import(pathToFileURL(join(REPO, 'tools/debug-mcp/tools.js')));
const toolNames = new Set(TOOLS.map((t) => t.name));
const toolArgs = new Map(
    TOOLS.map((t) => [t.name, new Set(Object.keys(t.inputSchema?.properties ?? {}))]),
);
const everyArg = new Set([...toolArgs.values()].flatMap((s) => [...s]));

// `exec_lua` server-scope verbs: `cmd == "x"` / `cmd.rfind("x ", 0)`.
const execSrc = read(join(REPO, 'rts/Server/LuaExecEngine.cpp')) +
    read(join(REPO, 'rts/server_main.cpp'));
const execVerbs = new Set(
    [...execSrc.matchAll(/cmd(?:\s*==|\.rfind\()\s*"([a-z_]+)/g)].map((m) => m[1]),
);

// SQLite table AND column names, for the prose that hands you a query_db
// query. Columns matter as much as tables: a renamed column is drift a reader
// only discovers when their SQL returns "no such column", and the schema is
// written as C++ string literals, so it is greppable.
//
// The schema is spelled across concatenated literals —
//   "CREATE TABLE IF NOT EXISTS world_staging ("
//   "  poi_id TEXT NOT NULL,"
// — so scan for the `"  <name> <TYPE>` shape rather than trying to parse a
// statement that never exists as one string.
const tables = new Set();
const columns = new Set();
(function walkCpp(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkCpp(p);
        else if (/\.(cpp|h)$/.test(e.name)) {
            const src = read(p);
            for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g))
                tables.add(m[1]);
            for (const m of src.matchAll(
                /"\s*([a-z][a-z0-9_]*)\s+(?:INTEGER|TEXT|REAL|BLOB|NUMERIC)\b/g))
                columns.add(m[1]);
        }
    }
})(join(REPO, 'rts'));

// `window.test.*` — method and getter names off the TestHarness class.
// Plus the hooks that are ATTACHED at runtime rather than declared on the
// class: a widget that does `window.test.nl = …` in its init puts a real
// method on the harness, and a check that only reads the class file would call
// it drift. Scanned across client/src so the source of the hook can live with
// the feature it exposes.
const attachedHooks = new Set();
(function walkClient(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walkClient(p);
        else if (/\.(ts|js)$/.test(e.name))
            for (const m of read(p).matchAll(/window\.test\.([a-zA-Z][a-zA-Z0-9]*)\s*=[^=]/g))
                attachedHooks.add(m[1]);
    }
})(join(REPO, 'client/src'));

const harnessSrc = read(join(REPO, 'client/src/core/test-harness.ts'));
const harness = new Set(
    // Methods, getters and fields at class-body indent. `<` is in the opener
    // set because the harness's generic methods (`async serverJson<T>(…)`)
    // are otherwise invisible — and a method the check cannot see reads as a
    // method that does not exist.
    [...harnessSrc.matchAll(/^\s{4}(?:public\s+|private\s+|async\s+|get\s+|readonly\s+)*([a-zA-Z][a-zA-Z0-9]*)\s*[(:=<]/gm)]
        .map((m) => m[1]),
);

// HTTP routes, from two sources that are NOT interchangeable.
//
// A wildcard prefix ("/api/world/seasons/*") permits every path beneath it, so
// it may only ever come from a real route REGISTRATION — a quoted string
// literal in the C++. Harvesting wildcards out of prose inverts the check:
// docs/api.md says `/api/rtc/*` was **removed** in GW7, and an earlier cut of
// this file read that sentence as a licence for `/api/rtc/offer` — the exact
// dead route the 2026-09-10 review found in a skill. Prose contributes exact
// literals only, and never permission for anything beneath them.
const cppRouteText = read(join(REPO, 'rts/lobby_main.cpp')) +
    read(join(REPO, 'rts/server_main.cpp')) + read(join(REPO, 'rts/logserver_main.cpp'));
const docRouteText = read(join(REPO, 'docs/api.md'));

const routeLiterals = new Set();
const routePrefixes = [];
for (const m of cppRouteText.matchAll(/"(\/api\/[A-Za-z0-9_/*{}<>:-]*)"/g)) {
    const r = m[1];
    if (r.endsWith('*')) routePrefixes.push(r.slice(0, -1));
    else routeLiterals.add(r);
}
for (const m of docRouteText.matchAll(/\/api\/[A-Za-z0-9_/{}<>:-]*/g))
    routeLiterals.add(m[0].replace(/[.,)`'"]+$/, ''));

// Every file in the repo, by name. Two jobs: prose that names a file without
// its path ("edit `entity-renderer.ts`") is checked for existence SOMEWHERE
// rather than at the repo root, and snake_case tokens that are really file or
// scenario basenames (`game_scenario`, `lobby_main`, `scorched_crossing_v2`)
// resolve as the real things they are instead of as missing tools.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', '.venv', 'cache']);
const byName = new Map();   // basename -> every absolute path with that name
const stems = new Set();    // basename without extension
(function walkAll(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walkAll(p);
        else {
            // ALL of them, not the first: several trees hold a
            // `vitest.config.js`, and keeping only one makes the suffix check
            // below reject the correct path to any of the others.
            if (!byName.has(e.name)) byName.set(e.name, []);
            byName.get(e.name).push(p);
            stems.add(e.name.replace(/\.[^.]+$/, ''));
        }
    }
})(REPO);

const allow = new Set(
    read(ALLOW_FILE).split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean),
);

// ─── The files under check ──────────────────────────────────────────────────

const docs = [];
for (const root of ['.claude/skills', '.claude/agents']) {
    const dir = join(REPO, root);
    if (!existsSync(dir)) continue;
    (function walk(d) {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.md')) docs.push(p);
        }
    })(dir);
}
if (docs.length === 0) {
    console.error('check-skills: no .claude/{skills,agents}/**/*.md found — wrong cwd?');
    process.exit(2);
}

// ─── Rules ──────────────────────────────────────────────────────────────────

const looksLikeToolName = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

for (const file of docs) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    // Code fences hold runnable commands and sample output, not claims about
    // the tool surface; checking inside them reports every shell word.
    let fenced = false;

    lines.forEach((line, i) => {
        const n = i + 1;
        if (/^\s*```/.test(line)) { fenced = !fenced; return; }
        if (fenced) return;

        // 1. snake_case identifiers in backticks must be SOMETHING real.
        for (const m of line.matchAll(/`([^`]+)`/g)) {
            const inner = m[1];
            // `tool({args})` and `tool` both reduce to the leading identifier.
            const token = inner.match(/^([a-z][a-z0-9_]*)/)?.[1];
            if (!token || !looksLikeToolName.test(token)) continue;
            if (toolNames.has(token) || execVerbs.has(token) || tables.has(token) ||
                columns.has(token) || everyArg.has(token) || stems.has(token) ||
                allow.has(token)) continue;
            report(file, n, 'unknown-name',
                `\`${token}\` is not an MCP tool, exec verb, table, column, ` +
                `tool argument, repo file or allowlisted name`);
        }

        // 2. Arguments named against a specific tool must belong to that tool.
        //    Matches the skills' own house style: `tool_name({a, b, c})`.
        for (const m of line.matchAll(/`([a-z_]+)\(\{([^}]*)\}\)`/g)) {
            const [, tool, argBlob] = m;
            if (!toolNames.has(tool)) continue;
            const known = toolArgs.get(tool);
            // KEYS only. The skills write defaults inline (`wait='ticking'`,
            // `openBrowser:true`), and a value is not an argument name — an
            // earlier cut of this rule reported `ticking` and `true` as
            // arguments, which is exactly the kind of noise that gets a drift
            // check switched off.
            for (const part of argBlob.split(',')) {
                const arg = part.trim().match(/^([a-zA-Z][a-zA-Z0-9]*)\s*[?]?\s*(?:[:=]|$)/)?.[1];
                if (!arg || arg === '…') continue;
                if (!known.has(arg) && !allow.has(`${tool}.${arg}`))
                    report(file, n, 'unknown-arg', `${tool} has no argument \`${arg}\``);
            }
        }

        // 3. Every /api/... path must be a route the servers register.
        for (const m of line.matchAll(/\/api\/[A-Za-z0-9_/{}<>:-]+\*?/g)) {
            const raw = m[0].replace(/[.,)]+$/, '');
            const route = raw.replace(/\*$/, '');
            if (routeLiterals.has(route)) continue;
            if (routePrefixes.some((p) => route.startsWith(p))) continue;
            if (allow.has(route)) continue;
            // `/api/world/*` in a skill names the FAMILY. True when at least
            // one real route sits under it; drift when none does — which is
            // how a whole removed family (GW7's `/api/rtc/*`) gets caught.
            if (raw.endsWith('*') &&
                [...routeLiterals].some((r) => r.startsWith(route))) continue;
            report(file, n, 'unknown-route', `${raw} is registered nowhere`);
        }

        // 4. window.test.<method> must exist on the harness.
        for (const m of line.matchAll(/\btest\.([a-zA-Z][a-zA-Z0-9]*)(\*?)/g)) {
            const [, method, star] = m;
            if (harness.has(method) || attachedHooks.has(method) ||
                allow.has(`test.${method}`)) continue;
            // `window.test.camera*` names a FAMILY (cameraPose, cameraOrbit,
            // cameraFitMap…). A prefix with at least one real member is a true
            // statement; a prefix with none is the drift worth reporting.
            if (star && [...harness, ...attachedHooks].some((h) => h.startsWith(method)))
                continue;
            report(file, n, 'unknown-harness-method',
                `window.test.${method} is not on TestHarness`);
        }

        // 5. Relative paths a skill points at must exist. Only paths that are
        //    unambiguously file references — a leading ./ or ../, or a known
        //    source extension — so prose like "the units/ tree" is left alone.
        for (const m of line.matchAll(/`((?:\.{1,2}\/)[^`\s)]+|[A-Za-z0-9_./-]+\.(?:lua|ts|js|mjs|cpp|h|md|json|sh|py))`/g)) {
            let p = m[1].split('#')[0];
            if (!p || allow.has(p)) continue;
            // `window.test.lua` is a harness METHOD whose name happens to end
            // in a source extension. Rule 4 owns it; this rule must not also
            // read it as a file path.
            if (/^(?:window\.)?test\./.test(p)) continue;
            // A bare basename is prose ("edit `entity-renderer.ts`"), not a
            // path from anywhere in particular: ask whether the repo has a
            // file by that name at all. Only a path with a separator is a
            // claim about WHERE the file is, and only that is resolved.
            if (!p.includes('/')) {
                if (!byName.has(p))
                    report(file, n, 'missing-path', `no file named ${p} anywhere in the repo`);
                continue;
            }
            const base = p.startsWith('.') ? dirname(file) : REPO;
            const abs = resolve(base, p);
            // A glob/placeholder segment cannot be stat'ed; check its parent.
            const probe = /[*<>{}]/.test(p) ? dirname(abs.split(/[*<>{}]/)[0]) : abs;
            try { statSync(probe); continue; } catch { /* fall through */ }
            // A path can be correct and still not resolve from the repo root:
            // the forge skill documents `prefabs/parts.py` relative to
            // tools/forge, the base its own commands cd into. Accept a path
            // that is a real suffix of some file in the repo — still enough to
            // catch a file that has moved or gone, which is the actual defect.
            const suffix = '/' + p.replace(/^\.\//, '');
            const known = byName.get(p.split('/').pop()) ?? [];
            if (known.some((k) => k.endsWith(suffix))) continue;
            report(file, n, 'missing-path', `${p} does not exist`);
        }
    });
}

// ─── Report ─────────────────────────────────────────────────────────────────

if (findings.length === 0) {
    console.log(
        `check-skills: OK — ${docs.length} files, ${toolNames.size} tools, ` +
        `${routeLiterals.size} routes, ` +
        `${harness.size}+${attachedHooks.size} harness methods, ` +
        `${tables.size} tables, ${columns.size} columns.`);
    process.exit(0);
}
for (const f of findings)
    console.error(`${f.file}:${f.line}: [${f.rule}] ${f.msg}`);
console.error(`\ncheck-skills: ${findings.length} finding(s) across ${docs.length} files.`);
console.error('Fix the skill, or — if the name is legitimately not a repo symbol —');
console.error(`add it to ${relative(REPO, ALLOW_FILE)} with a comment saying why.`);
process.exit(1);
