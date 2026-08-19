/**
 * `node --test tools/debug-mcp/` — pure-builder tests for launch_direct.
 *
 * The merge order is the tool's whole contract with a caller who starts from a
 * shipped manifest, so it is pinned here rather than discovered live: file →
 * `manifest` deep-merged → `overrides` shallow-merged last.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    buildDirectManifest, deepMerge, listManifestNames, loadManifestByName, manifestsDir,
} from './direct-manifest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FILE_MANIFEST = {
    name: 'dev:fixture',
    map: 'scorched_crossing_v2.4',
    game: 'metalstorm',
    modoptions: { fog: 'off', speed: '1' },
    players: [{ username: 'dev-compact', team: 0 }],
    aiSlots: [{ aiId: 'null', team: 1 }],
};

test('deepMerge recurses objects but replaces arrays and scalars', () => {
    const out = deepMerge(FILE_MANIFEST, {
        modoptions: { speed: '4' },
        players: [{ username: 'solo', team: 0 }],
    });
    // object recursed: the untouched key survives
    assert.equal(out.modoptions.fog, 'off');
    assert.equal(out.modoptions.speed, '4');
    // array replaced wholesale, not merged element-wise
    assert.deepEqual(out.players, [{ username: 'solo', team: 0 }]);
    assert.equal(out.map, 'scorched_crossing_v2.4');
});

test('deepMerge does not mutate its base', () => {
    const base = { modoptions: { fog: 'off' } };
    deepMerge(base, { modoptions: { fog: 'on', extra: '1' } });
    assert.deepEqual(base, { modoptions: { fog: 'off' } });
});

test('overrides replace top-level keys wholesale, winning over the deep merge', () => {
    const { manifest } = buildDirectManifest({
        fileManifest: FILE_MANIFEST,
        manifest: { modoptions: { speed: '4' } },
        overrides: { modoptions: { onlyThis: 'yes' } },
    });
    // shallow: the deep-merged modoptions object is discarded entirely
    assert.deepEqual(manifest.modoptions, { onlyThis: 'yes' });
});

test('a map is required, and the error names all three ways to set one', () => {
    const { error } = buildDirectManifest({ manifest: { name: 'dev:nomap' } });
    assert.match(error, /no "map"/);
    assert.match(error, /manifestName, manifest, or overrides/);
});

test('modoptions.scenario is hoisted to the top level, with a note', () => {
    const { manifest, notes } = buildDirectManifest({
        manifest: { map: 'm', modoptions: { scenario: 'crossing_standoff' } },
    });
    assert.equal(manifest.scenario, 'crossing_standoff');
    assert.ok(notes.some(n => n.includes('hoisted modoptions.scenario')));
});

test('an explicit top-level scenario is not overwritten by the hoist', () => {
    const { manifest, notes } = buildDirectManifest({
        manifest: { map: 'm', scenario: 'explicit', modoptions: { scenario: 'other' } },
    });
    assert.equal(manifest.scenario, 'explicit');
    assert.ok(!notes.some(n => n.includes('hoisted')));
});

test('an unnamed manifest is warned about (it launches as the shared "dev:direct")', () => {
    const { notes } = buildDirectManifest({ manifest: { map: 'm' } });
    assert.ok(notes.some(n => n.includes('dev:direct')));
});

test('idleGraceSeconds is sugar for manifest.idleStartupGraceSeconds, and is noted', () => {
    const { manifest, notes } = buildDirectManifest({
        fileManifest: FILE_MANIFEST, idleGraceSeconds: 600,
    });
    assert.equal(manifest.idleStartupGraceSeconds, 600);
    assert.ok(notes.some(n => n.includes('SPRING_IDLE_STARTUP_GRACE_SECONDS')));
});

test('an idle timer set in the manifest itself gets the same old-binary note', () => {
    const { notes } = buildDirectManifest({ manifest: { map: 'm', idleExitSeconds: 30 } });
    assert.ok(notes.some(n => n.includes('older one ignores')));
});

test('loadManifestByName refuses path traversal', () => {
    assert.throws(() => loadManifestByName('../secrets'), /bad manifestName/);
    assert.throws(() => loadManifestByName('sub/dir'), /bad manifestName/);
});

test('a manifestName miss lists the available names', () => {
    const prev = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = REPO_ROOT;
    try {
        assert.equal(manifestsDir(), join(REPO_ROOT, 'manifests'));
        const onDisk = readdirSync(join(REPO_ROOT, 'manifests'))
            .filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
        assert.deepEqual(listManifestNames(), onDisk);
        assert.ok(onDisk.includes('crossing_standoff_direct'));
        assert.throws(() => loadManifestByName('definitely_not_a_manifest'), err => {
            assert.match(err.message, /no manifest "definitely_not_a_manifest"/);
            for (const n of onDisk) assert.ok(err.message.includes(n), `missing "${n}" from the list`);
            return true;
        });
    } finally {
        if (prev === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prev;
    }
});

test('a shipped manifest loads and survives the builder unchanged', () => {
    const prev = process.env.PROJECT_ROOT;
    process.env.PROJECT_ROOT = REPO_ROOT;
    try {
        const file = loadManifestByName('crossing_standoff_direct');
        const { manifest, error } = buildDirectManifest({ fileManifest: file });
        assert.equal(error, null);
        assert.equal(manifest.map, file.map);
        assert.ok(manifest.name, 'the shipped manifest should carry its own name');
    } finally {
        if (prev === undefined) delete process.env.PROJECT_ROOT; else process.env.PROJECT_ROOT = prev;
    }
});
