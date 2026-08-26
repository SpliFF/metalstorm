// Stage a recording for a replay gate — one headless fixture game written to a
// `.msr` file, with every check that makes the resulting file worth gating on.
//
// Extracted from replay-verify-run.mjs on 2026-08-14 because the spectate gate
// (PLAN-replay §7.11 T2-a-1) needs the same recording under the same
// conditions. A second copy of this would be a second definition of "a
// recording good enough to gate on", and the checks below are exactly the ones
// a copy would quietly lose:
//
//   * a closed replay file (a truncated one still exists on disk),
//   * at least two embedded hash points (one is a pass by vacuity),
//   * a NON-VACUOUS world — peak units, damage AND deaths (T2-c/T3-d): a
//     comparison of two empty worlds cannot report that it compared nothing.
//
// Failures throw with the engine's own output attached; the caller decides how
// to print them, so this module stays usable from a unit test.

import path from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { loadJson, writeJson } from './config.mjs';
import { runHeadless } from './run-server.mjs';
import { checkFixtureNonVacuous, describeFixture } from './fixture-checks.mjs';

const RECORDED_RE =
    /replay recording closed: \S+ \((\d+) records, (\d+) hash points, end frame (-?\d+)\)/;

/** Last N lines of a run's combined output — what a CI reader needs. */
export function tail(result, n = 40) {
    return `${result.stdout}\n${result.stderr}`.split('\n').slice(-n).join('\n');
}

export class RecordingError extends Error {
    constructor(message, detail) {
        super(message);
        this.detail = detail;
    }
}

/**
 * Record `configPath`'s fixture to `<outDir>/run.msr`.
 *
 * @returns {Promise<{replayPath: string, records: number, hashPoints: number,
 *                    endFrame: number, measured: object, dumpPath: string}>}
 */
export async function recordFixture({
    serverBin, configFile, outDir, port, maxWallMin, repoRoot, hashEvery,
    clean = true, log = console.log,
}) {
    if (clean) await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const configPath = path.join(outDir, 'config.json');
    const dumpPath = path.join(outDir, 'record-dump.json');
    const replayPath = path.join(outDir, 'run.msr');

    const cfg = structuredClone(await loadJson(configFile));
    cfg.headless = cfg.headless ?? {};
    cfg.headless.statsDump = dumpPath;
    await writeJson(configPath, cfg);

    const rec = await runHeadless({
        serverBin, configPath, port, maxWallMin, cwd: repoRoot,
        dbPath: path.join(outDir, 'db-record.sqlite'),
        extraArgs: ['--journal-file', replayPath,
                    '--journal-hash-every', String(hashEvery)],
    });
    const recOut = `${rec.stdout}\n${rec.stderr}`;
    const recLine = recOut.match(RECORDED_RE);
    if (!recLine) {
        throw new RecordingError(
            'the recording pass never closed a replay file (no `replay recording closed:` line)',
            tail(rec));
    }
    const [, records, hashPoints, endFrame] = recLine;
    // A closed recording must also come from a cleanly-exited process. The
    // T2-b static-destruction abort (CWeaponDefHandler/~DynDamageArray, after
    // main returned) that used to make exit 134 a SUCCESS is fixed
    // (WeaponDefHandler.cpp placement-new singleton), so a non-zero exit here
    // is a genuine defect again, not noise to parse around.
    if (rec.exitCode !== 0) {
        throw new RecordingError(
            `the recording pass closed its replay file but exited ${rec.exitCode}`
            + `${rec.signal ? ` (signal ${rec.signal})` : ''} — a completed run must exit 0 `
            + '(T2-b is fixed; a non-zero exit is a real defect)',
            tail(rec));
    }
    log(`  recorded: ${records} records, ${hashPoints} hash points, end frame ${endFrame}`);
    if (Number(hashPoints) < 2) {
        throw new RecordingError(
            `the recording embedded only ${hashPoints} hash point(s) — `
            + `--journal-hash-every ${hashEvery} is too coarse for this run's length`,
            recLine[0]);
    }
    if (recOut.includes('[TRUNCATED SEGMENT]') || recOut.includes('WITH WRITE ERRORS')) {
        throw new RecordingError(
            'the recording pass produced a truncated/incomplete segment', tail(rec));
    }

    let dump;
    try {
        dump = JSON.parse(await readFile(dumpPath, 'utf8'));
    } catch (e) {
        throw new RecordingError(
            `the recording pass wrote no readable stats dump at ${dumpPath}: ${e.message}`,
            tail(rec));
    }
    const nonVacuous = checkFixtureNonVacuous(dump);
    log(`  fixture content: ${describeFixture(nonVacuous.measured)}`);
    if (!nonVacuous.ok) {
        throw new RecordingError(
            'the fixture is VACUOUS — a replay gate over it would prove nothing:\n  - '
            + nonVacuous.problems.join('\n  - '));
    }

    return {
        replayPath, dumpPath, measured: nonVacuous.measured,
        records: Number(records), hashPoints: Number(hashPoints),
        endFrame: Number(endFrame),
    };
}
