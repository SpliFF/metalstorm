/**
 * PLAN-protocol-guard task 2 — the client half of the build-time drift guard.
 *
 * The guard's whole job is to REFUSE, so every case here fabricates the drift
 * it is supposed to catch. The repo tree can only ever exercise the passing
 * arm (it is regenerated and committed together, by construction), and a test
 * that only reads the tree measures the tree, not the rule — so the refusing
 * arms get their own throwaway fixture directories.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkProtocolSchema,
    findFlatc,
    DEFAULT_REPO_ROOT,
    REGEN_MESSAGE,
} from '../../scripts/check-protocol-schema.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REAL_SCHEMA = join(REPO, 'schemas/protocol.fbs');
const REAL_CPP = join(REPO, 'rts/Server/ProtocolSchemaHash.h');
const REAL_TS = join(REPO, 'client/src/protocol/schema-hash.ts');

const flatc = findFlatc(REPO);
const JUNK = 'deadbeef'.repeat(8);

/**
 * A fixture repo: the real schema plus hash artefacts we can corrupt one at a
 * time. `protocol.fbs` keeps its BASENAME — the bfbs hash depends on it.
 */
function fixture(mutate: (paths: { schema: string; cpp: string; ts: string }) => void) {
    const root = mkdtempSync(join(tmpdir(), 'protocol-guard-test-'));
    mkdirSync(join(root, 'schemas'), { recursive: true });
    const paths = {
        schema: join(root, 'schemas/protocol.fbs'),
        cpp: join(root, 'ProtocolSchemaHash.h'),
        ts: join(root, 'schema-hash.ts'),
    };
    copyFileSync(REAL_SCHEMA, paths.schema);
    copyFileSync(REAL_CPP, paths.cpp);
    copyFileSync(REAL_TS, paths.ts);
    mutate(paths);
    return {
        ...paths,
        root,
        check: (flatcOverride?: string | null) =>
            checkProtocolSchema({
                repoRoot: root,
                schema: paths.schema,
                cppHeader: paths.cpp,
                tsFile: paths.ts,
                flatc: flatcOverride === undefined ? flatc : flatcOverride,
            }),
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

function setHash(file: string, hash: string) {
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.replace(/[0-9a-f]{64}/, hash));
}

describe('protocol schema drift guard', () => {
    it('accepts the tree as committed', () => {
        const result = checkProtocolSchema({ repoRoot: REPO });
        expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
        // Whichever mode ran, the two committed artefacts must agree — that is
        // the part of the check that needs no toolchain.
        expect(readFileSync(REAL_CPP, 'utf8')).toContain(result.hash);
        expect(readFileSync(REAL_TS, 'utf8')).toContain(result.hash);
    });

    it('reports which mode it ran in, and finds flatc in a configured tree', () => {
        // Nothing about this project's checkout guarantees a build dir, so the
        // assertion is on the pairing, not on the mode: flatc present ⇒ the
        // authoritative check ran.
        const result = checkProtocolSchema({ repoRoot: REPO });
        expect(result.mode).toBe(flatc ? 'bfbs' : 'cross-check');
        expect(findFlatc(REPO)).toBe(flatc);
    });

    it('refuses when the schema moved and nothing was regenerated', () => {
        const f = fixture(({ schema }) => {
            writeFileSync(
                schema,
                readFileSync(schema, 'utf8').replace(
                    'table Handshake {',
                    'table Handshake {\n  drift_probe: uint32;'),
            );
        });
        try {
            if (!flatc) return; // needs the toolchain; the cross-check arm cannot see this
            expect(() => f.check()).toThrow(/committed schema hash is stale/);
            expect(() => f.check()).toThrow(new RegExp(REGEN_MESSAGE));
        } finally {
            f.cleanup();
        }
    });

    it('passes a comment-only schema edit without demanding a regen', () => {
        const f = fixture(({ schema }) => {
            writeFileSync(schema, readFileSync(schema, 'utf8') + '\n// a passing remark\n');
        });
        try {
            if (!flatc) return;
            expect(f.check().mode).toBe('bfbs');
        } finally {
            f.cleanup();
        }
    });

    it('refuses a half-applied regen even with no toolchain available', () => {
        const f = fixture(({ ts }) => setHash(ts, JUNK));
        try {
            expect(() => f.check(null)).toThrow(/two committed schema hashes disagree/);
            expect(() => f.check(null)).toThrow(new RegExp(REGEN_MESSAGE));
        } finally {
            f.cleanup();
        }
    });

    it('refuses a hand-edited pair that agrees with itself but not the schema', () => {
        // Both artefacts consistent, both wrong: only the bfbs arm can see this,
        // which is exactly why the cross-check mode is reported and not silent.
        const f = fixture(({ cpp, ts }) => {
            setHash(cpp, JUNK);
            setHash(ts, JUNK);
        });
        try {
            expect(f.check(null).mode).toBe('cross-check');
            if (!flatc) return;
            expect(() => f.check()).toThrow(/committed schema hash is stale/);
        } finally {
            f.cleanup();
        }
    });

    it('refuses an artefact with no hash in it at all', () => {
        const f = fixture(({ cpp }) => writeFileSync(cpp, '#pragma once\n'));
        try {
            expect(() => f.check(null)).toThrow(/no SCHEMA_HASH found/);
        } finally {
            f.cleanup();
        }
    });
});
