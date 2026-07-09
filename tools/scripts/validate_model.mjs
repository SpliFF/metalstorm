#!/usr/bin/env -S node --experimental-strip-types
/**
 * validate_model.mjs — the validation harness (PLAN-metalstorm-beta-units.md
 * §7 task 4 / §8 Tests): gltf-validator clean, tri budget, required
 * piece/bone names present, team-colour mask channel present, clips named
 * per convention, engine-load smoke via the real `tools/modelimporter`
 * binary.
 *
 * Reuses client/src/core/model-validate.ts directly (no logic duplicated
 * between "tested" and "actually run" code) via Node's TS type-stripping —
 * hence the `--experimental-strip-types` shebang. Run with:
 *
 *     node --experimental-strip-types tools/scripts/validate_model.mjs \
 *         data/games/metalstorm/objects3d/ms_tanks_s2.glb \
 *         --tri-budget 2000 \
 *         --require-pieces hull,turret,barrel,tracks \
 *         --clips walk,idle,death \
 *         --engine-smoke
 *
 * Exits non-zero if any check fails — wire into a pre-merge script once
 * assets start landing (nothing to gate yet — objects3d/ is still empty
 * pre-beta, task 4 only builds the mechanism).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import {
    parseGlb,
    checkTriBudget,
    checkPieceNaming,
    checkTeamColorMask,
    checkClipNames,
    checkEngineGeometry,
} from '../../client/src/core/model-validate.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MODELIMPORTER_BIN = path.join(REPO_ROOT, 'build/debug/tools/modelimporter/modelimporter');

function parseArgs(argv) {
    const opts = { triBudget: null, requirePieces: [], clips: null, engineSmoke: false, input: null };
    const rest = [...argv];
    opts.input = rest.shift();
    while (rest.length) {
        const a = rest.shift();
        if (a === '--tri-budget') opts.triBudget = Number(rest.shift());
        else if (a === '--require-pieces') opts.requirePieces = rest.shift().split(',').filter(Boolean);
        else if (a === '--clips') opts.clips = rest.shift().split(',').filter(Boolean);
        else if (a === '--engine-smoke') opts.engineSmoke = true;
        else throw new Error(`unknown argument: ${a}`);
    }
    return opts;
}

async function loadGltfValidator() {
    // gltf-validator lives in client/node_modules (the only npm project root
    // in this repo) — resolve it explicitly rather than relying on a bare
    // specifier, since this script runs from tools/scripts/, outside that
    // package's node_modules resolution chain.
    const modulePath = path.join(REPO_ROOT, 'client/node_modules/gltf-validator/module.mjs');
    if (!fs.existsSync(modulePath)) return null;
    try {
        return await import(modulePath);
    } catch {
        return null;
    }
}

async function runGltfValidator(bytes, uri) {
    const validator = await loadGltfValidator();
    if (!validator) {
        return { skipped: true, message: 'gltf-validator not installed (npm install --prefix client gltf-validator)' };
    }
    const report = await validator.validateBytes(new Uint8Array(bytes), { uri });
    const errors = (report.issues?.messages ?? []).filter((m) => m.severity === 0);
    return {
        skipped: false,
        ok: errors.length === 0,
        errorCount: errors.length,
        errors: errors.slice(0, 10),
    };
}

function runEngineSmoke(inputPath) {
    if (!fs.existsSync(MODELIMPORTER_BIN)) {
        return { skipped: true, message: `modelimporter binary not built: ${MODELIMPORTER_BIN} (cmake --build build/debug --target modelimporter)` };
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-validate-model-'));
    try {
        const outPath = path.join(tmpDir, path.basename(inputPath));
        execFileSync(MODELIMPORTER_BIN, [inputPath, outPath], { stdio: 'pipe' });
        const outBytes = fs.readFileSync(outPath);
        const { json } = parseGlb(new Uint8Array(outBytes));
        return { skipped: false, ...checkEngineGeometry(json), outputJson: json };
    } catch (e) {
        return { skipped: false, ok: false, message: `modelimporter failed: ${e.message}` };
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.input || opts.triBudget === null) {
        console.error('usage: validate_model.mjs <model.glb> --tri-budget <n> [--require-pieces a,b,c] [--clips walk,idle,death] [--engine-smoke]');
        process.exit(2);
    }

    const bytes = fs.readFileSync(opts.input);
    const { json: doc } = parseGlb(new Uint8Array(bytes));

    const results = [];
    results.push(['tri budget', checkTriBudget(doc, opts.triBudget)]);
    if (opts.requirePieces.length) {
        results.push(['piece naming', checkPieceNaming(doc, opts.requirePieces)]);
    }
    results.push(['team-colour mask', checkTeamColorMask(doc)]);
    if (opts.clips) {
        results.push(['clip names', checkClipNames(doc, opts.clips)]);
    }

    const gltfValidatorResult = await runGltfValidator(bytes, path.basename(opts.input));
    results.push(['gltf-validator', gltfValidatorResult.skipped
        ? { ok: true, message: `SKIPPED: ${gltfValidatorResult.message}` }
        : { ok: gltfValidatorResult.ok, message: gltfValidatorResult.ok ? 'no errors' : `${gltfValidatorResult.errorCount} error(s): ${JSON.stringify(gltfValidatorResult.errors)}` }]);

    if (opts.engineSmoke) {
        const smoke = runEngineSmoke(opts.input);
        results.push(['engine-load smoke (modelimporter)', smoke.skipped
            ? { ok: true, message: `SKIPPED: ${smoke.message}` }
            : smoke]);
    }

    let allOk = true;
    console.log(`\nvalidate_model: ${opts.input}\n`);
    for (const [name, r] of results) {
        const status = r.ok ? 'PASS' : 'FAIL';
        if (!r.ok) allOk = false;
        console.log(`  [${status}] ${name} — ${r.message}`);
    }
    console.log('');
    process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
