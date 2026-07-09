/**
 * assets-manifest — validate `data/games/metalstorm/ASSETS.md` (the asset
 * licensing manifest, PLAN-metalstorm-beta-units.md §1/task 2) against the
 * real unit defs and the files actually landed in `objects3d/`/`unittextures/`.
 *
 * Def→model resolution runs the *real* def Lua through Fengari (same
 * LuaRuntime used for mapinfo.lua — see map-lighting.ts) rather than
 * regex-guessing `objectname` out of the source text: `units/<class>.lua`
 * files call `VFS.Include('units/_builder.lua')` and invoke the returned
 * `mk` closure, so a faithful reader has to actually execute that closure
 * the way the engine's Lua loader would. `civilians.lua`/`civvehicles.lua`/
 * `buildings_*.lua` return literal def tables (no builder) and evaluate
 * the same way.
 */
import * as fs from 'fs';
import * as path from 'path';
import { LuaRuntime, type LuaValue } from './lua-runtime.js';

export interface DefModelRef {
    defName: string;
    objectname: string;
    sourceFile: string;
}

export interface ManifestRow {
    assetPath: string;
    targetDefs: string;
    origin: string;
    author: string;
    license: string;
    modifications: string;
    /** 1-based line number in the source markdown, for error messages. */
    line: number;
}

export interface AssetViolation {
    severity: 'error' | 'warning';
    message: string;
    path?: string;
}

// Denylist wins over the allowlist — checked first. Matches PLAN-metalstorm-
// beta-units.md §1's prohibited class: NC/ND/"personal use"/proprietary.
const LICENSE_DENYLIST: RegExp[] = [
    /-nc\b/i, /non.?commercial/i,
    /-nd\b/i, /non.?derivative/i, /no.?derivatives/i,
    /personal use/i,
    /proprietary/i,
    /all rights reserved/i,
];

// §1's allowed classes, plus the two in-house classes ASSETS.md's own header
// documents (originally-authored project art; AI-generated PoC assets).
const LICENSE_ALLOWLIST: RegExp[] = [
    /^cc0\b/i,
    /public domain/i,
    /^cc-by(-sa)?(-\d)/i,
    /^cc-by(-sa)?\b/i,
    /^gpl-2\.0/i,
    /^original\b/i,
    /^generated\b/i,
];

export function isAllowedLicense(license: string): boolean {
    const l = license.trim();
    if (l === '') return false;
    if (LICENSE_DENYLIST.some((re) => re.test(l))) return false;
    return LICENSE_ALLOWLIST.some((re) => re.test(l));
}

/** Split a markdown table row into trimmed cells. Handles `\|` as an escaped pipe. */
function splitRow(line: string): string[] {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

/**
 * Parse the ASSETS.md manifest table. Skips the header, the `---` separator,
 * and the `_none yet_` placeholder row. Throws if the table header doesn't
 * match the expected 6 columns (format drift should fail loudly, not
 * silently parse garbage).
 */
export function parseAssetsManifest(markdown: string): ManifestRow[] {
    const lines = markdown.split('\n');
    const rows: ManifestRow[] = [];
    let sawHeader = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim().startsWith('|')) continue;
        const cells = splitRow(line);
        if (!sawHeader) {
            if (cells[0].toLowerCase().startsWith('asset')) {
                sawHeader = true;
            }
            continue;
        }
        // Separator row: |---|---|...
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        if (cells.length < 6) {
            throw new Error(`ASSETS.md line ${i + 1}: expected 6 columns, got ${cells.length}`);
        }
        const [assetPath, targetDefs, origin, author, license, modifications] = cells;
        if (assetPath === '' || assetPath === '_none yet_') continue;
        rows.push({ assetPath, targetDefs, origin, author, license, modifications, line: i + 1 });
    }
    if (!sawHeader) {
        throw new Error('ASSETS.md: no manifest table header found (expected "| Asset (path in tree) | ...")');
    }
    return rows;
}

/** Run one `units/*.lua` def file through Fengari and return its defs table
 * (def name -> def table) as a plain JS object. Returns null on parse/eval
 * failure (caller decides how to report). */
function evalDefFile(unitsDir: string, filename: string): Record<string, LuaValue> | null {
    const filePath = path.join(unitsDir, filename);
    const source = fs.readFileSync(filePath, 'utf8');
    const rt = new LuaRuntime(`units/${filename}`);
    try {
        // VFS.Include resolves relative to the game root (units/_builder.lua),
        // matching real Spring VFS semantics — not relative to the caller's
        // own directory. gamedata/units are siblings under the same root.
        const gameRoot = path.resolve(unitsDir, '..');
        rt.setGlobal('VFS', {
            Include: (includePath: LuaValue): LuaValue => {
                if (typeof includePath !== 'string') return null;
                const resolved = path.join(gameRoot, includePath);
                const includeSource = fs.readFileSync(resolved, 'utf8');
                return rt.evalString(includeSource, includePath);
            },
        });
        const result = rt.evalString(source, filename);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
        return result as Record<string, LuaValue>;
    } catch {
        return null;
    } finally {
        rt.dispose();
    }
}

/**
 * Collect every def's `objectname` field across all `units/*.lua` files
 * (skips `_builder.lua` itself — it's a library, not a def file).
 */
export function collectDefModelRefs(unitsDir: string): DefModelRef[] {
    const refs: DefModelRef[] = [];
    const files = fs.readdirSync(unitsDir)
        .filter((f) => f.endsWith('.lua') && f !== '_builder.lua')
        .sort();
    for (const file of files) {
        const defs = evalDefFile(unitsDir, file);
        if (!defs) continue;
        for (const [defName, def] of Object.entries(defs)) {
            if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
            const objectname = (def as Record<string, LuaValue>).objectname;
            if (typeof objectname === 'string' && objectname !== '') {
                refs.push({ defName, objectname, sourceFile: file });
            }
        }
    }
    return refs;
}

function listFiles(dir: string, ext: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext)).sort();
}

export interface ValidateAssetsOptions {
    /** `data/games/metalstorm/` */
    gameRoot: string;
}

/**
 * The manifest validation (task 2 / §8 Tests): every landed `.glb`/`.ktx2`
 * must have an ASSETS.md row with an allowed license — a def referencing an
 * unmanifested or NC/ND-licensed model fails loudly. Files not yet landed
 * (the common case pre-beta — nothing has been sourced yet) are not an
 * error; this only fires once an asset actually lands without paperwork.
 */
export function validateAssets(opts: ValidateAssetsOptions): AssetViolation[] {
    const { gameRoot } = opts;
    const violations: AssetViolation[] = [];

    const manifestPath = path.join(gameRoot, 'ASSETS.md');
    const manifestSrc = fs.readFileSync(manifestPath, 'utf8');
    const rows = parseAssetsManifest(manifestSrc);

    const byPath = new Map<string, ManifestRow>();
    for (const row of rows) {
        if (byPath.has(row.assetPath)) {
            violations.push({
                severity: 'error',
                message: `ASSETS.md line ${row.line}: duplicate row for "${row.assetPath}" (first at line ${byPath.get(row.assetPath)!.line})`,
                path: row.assetPath,
            });
            continue;
        }
        byPath.set(row.assetPath, row);
        if (!isAllowedLicense(row.license)) {
            violations.push({
                severity: 'error',
                message: `ASSETS.md line ${row.line}: "${row.assetPath}" has a disallowed/unrecognised license "${row.license}" (PLAN-metalstorm-beta-units.md §1 — CC0/CC-BY/CC-BY-SA/GPL-2.0+/Original/Generated only, no NC/ND)`,
                path: row.assetPath,
            });
        }
    }

    // Every real file under objects3d/ and unittextures/ needs manifest coverage.
    const objects3dDir = path.join(gameRoot, 'objects3d');
    const unittexturesDir = path.join(gameRoot, 'unittextures');
    const modelRefs = collectDefModelRefs(path.join(gameRoot, 'units'));
    const refsByObjectname = new Map<string, DefModelRef[]>();
    for (const ref of modelRefs) {
        const arr = refsByObjectname.get(ref.objectname) ?? [];
        arr.push(ref);
        refsByObjectname.set(ref.objectname, arr);
    }

    for (const file of listFiles(objects3dDir, '.glb')) {
        const assetPath = `objects3d/${file}`;
        const row = byPath.get(assetPath);
        const stem = file.replace(/\.glb$/i, '');
        const referencedBy = refsByObjectname.get(stem) ?? [];
        if (!row) {
            const defList = referencedBy.length
                ? ` (referenced by def${referencedBy.length > 1 ? 's' : ''}: ${referencedBy.map((r) => r.defName).join(', ')})`
                : '';
            violations.push({
                severity: 'error',
                message: `${assetPath} has no ASSETS.md manifest row${defList} — every landed model needs a licensing row before merge (§1)`,
                path: assetPath,
            });
        } else if (!isAllowedLicense(row.license)) {
            // Already reported above via byPath scan, but keep the file-side
            // message too since it names the specific violating file.
            violations.push({
                severity: 'error',
                message: `${assetPath} is manifested with a disallowed licence "${row.license}"`,
                path: assetPath,
            });
        }
    }

    for (const file of listFiles(unittexturesDir, '.ktx2')) {
        const assetPath = `unittextures/${file}`;
        const row = byPath.get(assetPath);
        if (!row) {
            violations.push({
                severity: 'error',
                message: `${assetPath} has no ASSETS.md manifest row — every landed texture needs a licensing row before merge (§1)`,
                path: assetPath,
            });
        } else if (!isAllowedLicense(row.license)) {
            violations.push({
                severity: 'error',
                message: `${assetPath} is manifested with a disallowed licence "${row.license}"`,
                path: assetPath,
            });
        }
    }

    // Nice-to-have: flag manifest rows pointing at defs that don't exist
    // (typo detection) — warning, not an error, since Target def(s) is free text.
    const knownDefNames = new Set(modelRefs.map((r) => r.defName));
    for (const row of rows) {
        const targets = row.targetDefs.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        for (const t of targets) {
            if (t.startsWith('ms_') && !knownDefNames.has(t)) {
                violations.push({
                    severity: 'warning',
                    message: `ASSETS.md line ${row.line}: "${row.assetPath}" targets unknown def "${t}"`,
                    path: row.assetPath,
                });
            }
        }
    }

    return violations;
}
