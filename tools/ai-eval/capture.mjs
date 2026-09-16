#!/usr/bin/env node
/**
 * capture.mjs — run a real `spring-server --headless-run` with the engine's
 * Capture AI (content/engine/ai/capture) on one team, grep its snapshot
 * dumps out of the log, and write them as one raw-capture JSON file.
 *
 * This is NOT a fixture — it's the recording tape. A fixture is authored BY
 * HAND from a capture's output (pick a frame window, pick the events worth
 * naming), the same way every other tools/ai-eval/fixtures/*.json is; see
 * README "Writing a fixture". What this script buys over hand-typing a
 * fixture from imagination is that `initial`/`timeline` positions, the
 * region graph, and the power table are REAL — the same shapes the engine's
 * own AIStateSnapshot serializer and MapProcessor/def-export produce, not a
 * human's guess at what those look like.
 *
 *   node tools/ai-eval/capture.mjs --manifest tools/ai-eval/capture/manifest.json \
 *       --out build/ai-eval/capture-raw.json
 *
 * The manifest is a plain `--headless-run` config (map/game/scenario/
 * aiSlots/headless — docs/debugging-tools.md "Headless Run Mode") with a
 * `content/engine/ai/capture` slot on the team you want to observe and a
 * real AI (garrison/strategos) on the opposing team, so there is something
 * for the capture team to actually see.
 *
 * Exit codes mirror run-eval.mjs's spirit: 0 ok, 3 the harness itself
 * couldn't run (no server binary, the run never produced a capture line).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHeadless } from '../headless-batch/lib/run-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

function flag(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
    return fallback;
}

const MANIFEST = flag('manifest', join(HERE, 'capture', 'manifest.json'));
const OUT = flag('out', join(ROOT, 'build/ai-eval/capture-raw.json'));
const FRAMES = flag('frames', '');
const PORT = Number(flag('port', String((Number(process.env.TASKHERD_PORT_BASE) || 22700))));
const MAX_WALL_MIN = Number(flag('max-wall-min', '5'));
const SERVER_BIN = flag('server-bin', join(ROOT, 'build/prod/spring-server'));

if (!existsSync(SERVER_BIN)) {
    console.error(`ai-eval capture: no server binary at ${SERVER_BIN} — build it first, `
        + `or pass --server-bin.`);
    process.exit(3);
}
if (!existsSync(MANIFEST)) {
    console.error(`ai-eval capture: no manifest at ${MANIFEST}`);
    process.exit(3);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (FRAMES) {
    manifest.headless = manifest.headless || {};
    manifest.headless.stopAt = { frame: Number(FRAMES) };
}
const scratchDir = join(ROOT, 'build/ai-eval');
mkdirSync(scratchDir, { recursive: true });
const runConfigPath = join(scratchDir, 'capture-config.json');
const dbPath = join(scratchDir, 'capture.sqlite');
writeFileSync(runConfigPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`ai-eval capture: ${SERVER_BIN} --headless-run ${runConfigPath} `
    + `(stopAt=${JSON.stringify(manifest.headless?.stopAt)})`);

const result = await runHeadless({
    serverBin: SERVER_BIN, configPath: runConfigPath, port: PORT, dbPath,
    maxWallMin: MAX_WALL_MIN, cwd: ROOT,
});

if (result.exitCode !== 0) {
    console.error(`ai-eval capture: spring-server exited ${result.exitCode} (signal ${result.signal})`);
    console.error(result.stderr || result.stdout.slice(-4000));
    process.exit(3);
}

// The Capture AI's lines: `AICAPTURE <tag> <json>`. Everything else on the
// log (the real AI's own tick narration, engine noise) is not ours to parse.
const MARKER = /AICAPTURE (\w+) (.*)$/;
let regions = null;
// The Capture AI chunks the power table across several 'power' lines (one
// log line has a real, ~8 KB truncation ceiling — measured, not documented
// anywhere the engine side admits to) — merge every chunk's `defs`.
const power = { defs: {} };
let sawPower = false;
const samples = [];
for (const line of result.stdout.split('\n')) {
    const m = MARKER.exec(line);
    if (!m) continue;
    const [, tag, payload] = m;
    try {
        const data = JSON.parse(payload);
        if (tag === 'regions') regions = data;
        else if (tag === 'power') { sawPower = true; Object.assign(power.defs, data.defs); }
        else if (tag === 'sample') samples.push(data);
    } catch (err) {
        console.error(`ai-eval capture: unparseable ${tag} line (${payload.length} bytes) — `
            + `probably a truncated log line: ${err.message}`);
    }
}

if (!samples.length) {
    console.error('ai-eval capture: the run produced zero capture samples — check the manifest '
        + "puts content/engine/ai/capture on a team slot, and that spring-server's log reached "
        + 'this process (see stderr above).');
    process.exit(3);
}

const out = { manifest, regions, power: sawPower ? power : null, samples };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`ai-eval capture: ${samples.length} samples, ${regions ? regions.regions?.length ?? 0 : 0} `
    + `regions, ${Object.keys(power.defs).length} defs -> ${OUT}`);
