import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    isAllowedLicense,
    parseAssetsManifest,
    collectDefModelRefs,
    validateAssets,
    type TreeReader,
} from './assets-manifest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const METALSTORM_ROOT = path.join(REPO_ROOT, 'data/games/metalstorm');

// The module is fs-free (browser tsconfig has no Node types); tests supply
// the real filesystem through the TreeReader seam.
const nodeReader: TreeReader = {
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    listDir: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
};

describe('isAllowedLicense', () => {
    it('allows the §1 preferred/usable classes', () => {
        expect(isAllowedLicense('CC0')).toBe(true);
        expect(isAllowedLicense('CC0-1.0')).toBe(true);
        expect(isAllowedLicense('Public Domain')).toBe(true);
        expect(isAllowedLicense('CC-BY 4.0')).toBe(true);
        expect(isAllowedLicense('CC-BY-SA 3.0')).toBe(true);
        expect(isAllowedLicense('GPL-2.0-or-later')).toBe(true);
        expect(isAllowedLicense('GPL-2.0+')).toBe(true);
        expect(isAllowedLicense('Original (Metalstorm project)')).toBe(true);
        expect(isAllowedLicense('Generated (Claude, seed=1234)')).toBe(true);
    });

    it('rejects NC/ND/personal-use/proprietary terms', () => {
        expect(isAllowedLicense('CC-BY-NC 4.0')).toBe(false);
        expect(isAllowedLicense('CC-BY-ND 4.0')).toBe(false);
        expect(isAllowedLicense('CC-BY-NC-SA 4.0')).toBe(false);
        expect(isAllowedLicense('Free for personal use')).toBe(false);
        expect(isAllowedLicense('Proprietary')).toBe(false);
        expect(isAllowedLicense('All rights reserved')).toBe(false);
        expect(isAllowedLicense('')).toBe(false);
    });

    it('fails loudly (denies) on an unrecognised license string rather than guessing', () => {
        expect(isAllowedLicense('Some made-up license v2')).toBe(false);
    });
});

describe('parseAssetsManifest', () => {
    it('skips the header, separator, and _none yet_ placeholder', () => {
        const md = [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| _none yet_ | | | | | |',
        ].join('\n');
        expect(parseAssetsManifest(md)).toEqual([]);
    });

    it('parses a real row', () => {
        const md = [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/ms_tanks_s2.glb | ms_tanks_s2 | https://example.com/pack | Some Author | CC0 | rescaled, retextured |',
        ].join('\n');
        const rows = parseAssetsManifest(md);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            assetPath: 'objects3d/ms_tanks_s2.glb',
            targetDefs: 'ms_tanks_s2',
            license: 'CC0',
        });
    });

    it('throws on a malformed table (fails loudly on format drift)', () => {
        const md = [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/x.glb | only three | columns |',
        ].join('\n');
        expect(() => parseAssetsManifest(md)).toThrow();
    });

    it('throws on a row with extra columns instead of silently dropping them', () => {
        const md = [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/x.glb | ms_x | https://example.com | A | CC0 | none | surprise |',
        ].join('\n');
        expect(() => parseAssetsManifest(md)).toThrow(/expected 6 columns, got 7/);
    });

    it('ends the table at the first non-table line — a second table in the doc is not parsed as rows', () => {
        const md = [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/ms_tanks_s2.glb | ms_tanks_s2 | https://example.com | A | CC0 | none |',
            '',
            '## Tooling notes',
            '',
            '| Tool | Version | Notes |',
            '|---|---|---|',
            '| toktx | 4.3 | ktx2 encoder |',
        ].join('\n');
        const rows = parseAssetsManifest(md);
        expect(rows).toHaveLength(1);
        expect(rows[0].assetPath).toBe('objects3d/ms_tanks_s2.glb');
    });
});

describe('collectDefModelRefs (real Fengari execution against the real unit defs)', () => {
    const refs = collectDefModelRefs(METALSTORM_ROOT, nodeReader);

    it('executes the _builder.lua-based classes and finds all 4 scales', () => {
        const tankNames = refs.filter((r) => r.defName.startsWith('ms_tanks_s')).map((r) => r.defName);
        expect(tankNames.sort()).toEqual(['ms_tanks_s1', 'ms_tanks_s2', 'ms_tanks_s3', 'ms_tanks_s4']);
    });

    it('objectname matches the def name (per _builder.lua)', () => {
        const tankS2 = refs.find((r) => r.defName === 'ms_tanks_s2');
        expect(tankS2?.objectname).toBe('ms_tanks_s2');
    });

    it('executes the literal-table files (civilians, buildings) with no builder', () => {
        const names = refs.map((r) => r.defName);
        expect(names).toContain('ms_civilians');
        expect(names).toContain('ms_militia');
        expect(names).toContain('ms_civtruck');
        expect(names).toContain('ms_command_nexus');
        expect(names).toContain('ms_foundry');
        expect(names).toContain('ms_habitat');
        expect(names).toContain('ms_transit_hub');
    });

    it('covers all 11 builder classes x 4 scales', () => {
        const classes = ['engineers', 'soldiers', 'mechs', 'tanks', 'artillery', 'fighters',
            'bombers', 'ships', 'subs', 'staticdefense', 'radar'];
        for (const cls of classes) {
            for (let s = 1; s <= 4; s++) {
                expect(refs.some((r) => r.defName === `ms_${cls}_s${s}`)).toBe(true);
            }
        }
    });
});

describe('validateAssets — real repo tree (the CI-style check)', () => {
    it('the live data/games/metalstorm tree has no manifest violations', () => {
        const violations = validateAssets({ gameRoot: METALSTORM_ROOT, reader: nodeReader });
        const errors = violations.filter((v) => v.severity === 'error');
        expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
    });
});

describe('validateAssets — synthetic fixtures (proves the check actually catches violations)', () => {
    const tmpDirs: string[] = [];

    function makeFixture(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-assets-test-'));
        fs.mkdirSync(path.join(dir, 'units'));
        fs.mkdirSync(path.join(dir, 'objects3d'));
        fs.mkdirSync(path.join(dir, 'unittextures'));
        tmpDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        while (tmpDirs.length) {
            fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
        }
    });

    it('fails loudly on an unmanifested model file', () => {
        const dir = makeFixture();
        fs.writeFileSync(path.join(dir, 'objects3d', 'ms_test_s1.glb'), 'stub');
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| _none yet_ | | | | | |',
        ].join('\n'));
        const violations = validateAssets({ gameRoot: dir, reader: nodeReader });
        expect(violations.some((v) =>
            v.severity === 'error' && v.path === 'objects3d/ms_test_s1.glb'
            && /no ASSETS\.md manifest row/.test(v.message))).toBe(true);
    });

    it('fails loudly on an NC-licensed manifest row', () => {
        const dir = makeFixture();
        fs.writeFileSync(path.join(dir, 'objects3d', 'ms_test_s1.glb'), 'stub');
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/ms_test_s1.glb | ms_test_s1 | https://example.com | Someone | CC-BY-NC 4.0 | none |',
        ].join('\n'));
        const violations = validateAssets({ gameRoot: dir, reader: nodeReader });
        expect(violations.some((v) =>
            v.severity === 'error' && v.path === 'objects3d/ms_test_s1.glb'
            && /disallowed/.test(v.message))).toBe(true);
    });

    it('passes clean on a properly-manifested CC0 asset', () => {
        const dir = makeFixture();
        fs.writeFileSync(path.join(dir, 'objects3d', 'ms_test_s1.glb'), 'stub');
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/ms_test_s1.glb | ms_test_s1 | https://example.com | Someone | CC0 | rescaled |',
        ].join('\n'));
        const violations = validateAssets({ gameRoot: dir, reader: nodeReader });
        expect(violations.filter((v) => v.severity === 'error')).toEqual([]);
    });

    it('fails the suite (with the file name) when a units/*.lua def file has a Lua error', () => {
        const dir = makeFixture();
        // Touches an unstubbed global — the runtime error must surface with
        // the def filename, not silently vanish from the licence gate.
        fs.writeFileSync(path.join(dir, 'units', 'broken.lua'),
            'return UnstubbedGlobal.mk("nope")\n');
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| _none yet_ | | | | | |',
        ].join('\n'));
        expect(() => collectDefModelRefs(dir, nodeReader)).toThrow(/broken\.lua/);
        expect(() => validateAssets({ gameRoot: dir, reader: nodeReader })).toThrow(/broken\.lua/);
    });

    it('matches manifest rows to files case-insensitively (extensions were already case-insensitive)', () => {
        const dir = makeFixture();
        fs.writeFileSync(path.join(dir, 'objects3d', 'ms_test_s1.GLB'), 'stub');
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/MS_Test_S1.glb | ms_test_s1 | https://example.com | Someone | CC0 | none |',
        ].join('\n'));
        const violations = validateAssets({ gameRoot: dir, reader: nodeReader });
        expect(violations.filter((v) => v.severity === 'error')).toEqual([]);
    });

    it('flags a manifest row for a def that does not exist (warning, not error)', () => {
        const dir = makeFixture();
        fs.writeFileSync(path.join(dir, 'ASSETS.md'), [
            '| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |',
            '|---|---|---|---|---|---|',
            '| objects3d/ms_typo_s9.glb | ms_typo_s9 | https://example.com | Someone | CC0 | n/a |',
        ].join('\n'));
        // No actual file landed for this row, so no error — but the target def
        // name is bogus, which should still surface as a warning.
        const violations = validateAssets({ gameRoot: dir, reader: nodeReader });
        expect(violations.filter((v) => v.severity === 'error')).toEqual([]);
        expect(violations.some((v) => v.severity === 'warning' && /unknown def/.test(v.message))).toBe(true);
    });
});
