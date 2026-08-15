// Direct-start manifest loading and merging (PLAN-test-automation/P3).
//
// `manifests/*.json` are the raw bodies of POST /api/rooms/direct. They are the
// manual sibling of launch_scenario's in-memory manifest: same endpoint, same
// shape, but the caller controls every field. Kept out of server.js so the
// merge rules — the part with edge cases — are unit-testable without starting
// an MCP stdio server.

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

export function manifestsDir() {
    return join(process.env.PROJECT_ROOT || resolve('.'), 'manifests');
}

export function listManifestNames() {
    try {
        return readdirSync(manifestsDir())
            .filter(f => f.endsWith('.json'))
            .map(f => f.slice(0, -5))
            .sort();
    } catch { return []; }
}

export function loadManifestByName(name) {
    if (name.includes('/') || name.includes('..')) throw new Error(`bad manifestName "${name}"`);
    const p = join(manifestsDir(), `${name}.json`);
    if (!existsSync(p)) {
        const avail = listManifestNames().join(', ');
        throw new Error(`no manifest "${name}" in ${manifestsDir()} — available: `
            + (avail || '(none — is PROJECT_ROOT set?)'));
    }
    return JSON.parse(readFileSync(p, 'utf8'));
}

// Objects recurse; arrays and scalars replace wholesale. An array merged
// element-wise would make `players` unreplaceable, which is the one thing a
// caller overriding a shipped manifest most often wants to do.
export function deepMerge(base, over) {
    if (over === undefined) return base;
    if (over === null || typeof over !== 'object' || Array.isArray(over)) return over;
    const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(out[k], v);
    return out;
}

/// Apply the documented merge order and the shape fixups a direct manifest
/// needs before it is worth POSTing. Returns {manifest, notes, error} — `error`
/// is a caller-facing string when the result could not be launched at all.
export function buildDirectManifest({ fileManifest, manifest, overrides, idleGraceSeconds } = {}) {
    const notes = [];
    let m = fileManifest ? { ...fileManifest } : {};
    if (manifest) m = deepMerge(m, manifest);
    if (overrides) m = { ...m, ...overrides };
    if (typeof idleGraceSeconds === 'number' && idleGraceSeconds > 0) {
        m.idleStartupGraceSeconds = idleGraceSeconds;
    }
    if (!m.map) {
        return {
            manifest: m, notes,
            error: 'manifest has no "map" — every direct start needs one. '
                 + 'Set it via manifestName, manifest, or overrides.',
        };
    }
    // A modoptions-only scenario is silently overwritten by the map's own
    // default (lobby_main.cpp runDirectStart); hoisting it is the same fix
    // launch_scenario applies when a caller passes modoptions.scenario.
    if (!m.scenario && m.modoptions?.scenario) {
        m.scenario = m.modoptions.scenario;
        notes.push(`hoisted modoptions.scenario ("${m.scenario}") to the manifest top level — `
                 + 'as a modoption alone the lobby overwrites it with the map default.');
    }
    if (!m.name) {
        notes.push('manifest has no "name", so it launches as "dev:direct" — a second unnamed launch '
                 + 'anywhere on this lobby will tear this room down. Set a distinct name '
                 + '(e.g. "dev:<lane>-<purpose>") when other agents share the stack.');
    }
    if (typeof m.idleStartupGraceSeconds === 'number' || typeof m.idleExitSeconds === 'number') {
        notes.push('idle timers are honoured only by a lobby binary carrying P3; an older one ignores '
                 + 'the fields without error. Fallback: start the lobby with '
                 + 'SPRING_IDLE_STARTUP_GRACE_SECONDS in its env (applies to every room it spawns).');
    }
    return { manifest: m, notes, error: null };
}
