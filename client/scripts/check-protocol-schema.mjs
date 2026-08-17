/**
 * Build-time drift guard for the wire schema, client half
 * (PLAN-protocol-guard task 2; the server half is cmake/CheckProtocolSchemaHash.cmake).
 *
 * Asserts that the committed schema-hash artefacts still describe
 * schemas/protocol.fbs, so a bundle can never ship bindings that disagree with
 * the schema the server was built from.
 *
 * Two modes, and the mode is always reported rather than silently chosen:
 *
 *   'bfbs'        flatc was found, so the hash is recomputed from the binary
 *                 schema exactly as scripts/regen-protocol.sh does. This is the
 *                 authoritative check: it catches an fbs edit with no regen.
 *   'cross-check' no configured build dir, so no flatc (a client-only checkout).
 *                 Falls back to asserting the two committed hash files agree
 *                 with each other, which catches a half-applied regen or a
 *                 half-resolved merge but NOT an unregenerated schema edit.
 *
 * Plain .mjs rather than TypeScript because it runs from two places that cannot
 * consume TS: the `prebuild` npm hook, and vite.config.ts's guard plugin (which
 * covers `vite dev`, the path mprocs actually launches — npm lifecycle hooks do
 * not fire there).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(HERE, '../..');

export const REGEN_MESSAGE =
    'protocol.fbs changed without regen — run scripts/regen-protocol.sh';

/**
 * flatc only exists once a CMake build dir has been configured (it comes from
 * the FetchContent step). Any configured build dir will do — they all build the
 * same pinned FlatBuffers version. Same search as scripts/regen-protocol.sh.
 */
export function findFlatc(repoRoot = DEFAULT_REPO_ROOT) {
    const buildRoot = join(repoRoot, 'build');
    const preferred = ['debug', 'release', 'prod'];
    let dirs = [];
    try {
        dirs = readdirSync(buildRoot);
    } catch {
        return null;
    }
    const ordered = [
        ...preferred.filter((d) => dirs.includes(d)),
        ...dirs.filter((d) => !preferred.includes(d)),
    ];
    for (const dir of ordered) {
        const candidate = join(buildRoot, dir, '_deps/flatbuffers-build/flatc');
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function extract(text, re, file) {
    const m = text.match(re);
    if (!m) throw new Error(`no SCHEMA_HASH found in ${file}\n${REGEN_MESSAGE}`);
    return m[1];
}

/**
 * @returns {{mode: 'bfbs'|'cross-check', hash: string, flatc: string|null}}
 * @throws  {Error} on any drift, with the run-the-script remedy in the message.
 */
export function checkProtocolSchema(opts = {}) {
    const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
    const schema = opts.schema ?? join(repoRoot, 'schemas/protocol.fbs');
    const cppHeader = opts.cppHeader ?? join(repoRoot, 'rts/Server/ProtocolSchemaHash.h');
    const tsFile = opts.tsFile ?? join(repoRoot, 'client/src/protocol/schema-hash.ts');
    const flatc = opts.flatc === undefined ? findFlatc(repoRoot) : opts.flatc;

    const cppHash = extract(
        readFileSync(cppHeader, 'utf8'), /SCHEMA_HASH\[\] = "([0-9a-f]+)"/, cppHeader);
    const tsHash = extract(
        readFileSync(tsFile, 'utf8'), /SCHEMA_HASH = '([0-9a-f]+)'/, tsFile);

    if (cppHash !== tsHash) {
        throw new Error(
            `the two committed schema hashes disagree — a half-applied regen.\n` +
            `  ${cppHeader} says ${cppHash}\n` +
            `  ${tsFile} says ${tsHash}\n${REGEN_MESSAGE}`);
    }

    if (!flatc) {
        return { mode: 'cross-check', hash: tsHash, flatc: null };
    }

    // The .bfbs hash depends on the schema's file BASENAME, so flatc is run on
    // schemas/protocol.fbs itself and only the OUTPUT goes to a temp dir. The
    // same bytes under another name hash differently and the guard would then
    // fail forever.
    const out = mkdtempSync(join(tmpdir(), 'protocol-guard-'));
    let actual;
    try {
        execFileSync(flatc, ['-b', '--schema', '-o', out, schema], { stdio: 'pipe' });
        actual = createHash('sha256')
            .update(readFileSync(join(out, 'protocol.bfbs')))
            .digest('hex');
    } finally {
        rmSync(out, { recursive: true, force: true });
    }

    if (actual !== tsHash) {
        throw new Error(
            `the committed schema hash is stale.\n` +
            `  ${schema} hashes to ${actual}\n` +
            `  the committed artefacts say ${tsHash}\n${REGEN_MESSAGE}`);
    }
    return { mode: 'bfbs', hash: actual, flatc };
}

/** Vite plugin wrapper — see vite.config.ts. */
export function protocolGuardPlugin(opts = {}) {
    return {
        name: 'protocol-schema-guard',
        buildStart() {
            const { mode, hash } = checkProtocolSchema(opts);
            const how = mode === 'bfbs'
                ? 'recomputed from schemas/protocol.fbs'
                : 'no flatc found (configure a build dir for the full check) — '
                  + 'committed artefacts cross-checked only';
            this.info?.(`protocol schema ${hash.slice(0, 12)}… ok — ${how}`);
        },
    };
}

// CLI: the `prebuild` npm hook.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
    try {
        const { mode, hash } = checkProtocolSchema();
        console.log(`check-protocol-schema: ok (${mode}) ${hash}`);
    } catch (err) {
        console.error(`check-protocol-schema: ${err.message}`);
        process.exit(1);
    }
}
