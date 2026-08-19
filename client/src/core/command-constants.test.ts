/**
 * Command-constant drift guard (PLAN-metalstorm-transports T0).
 *
 * The client carries the Spring command ids in three places — `command-buffer.ts`'s
 * `CMD`/`OPT` tables, the Lua `CMD` globals that `lua-ui-host.ts` injects into every
 * widget, and hand-rolled literals in the scenario benches. Before this test they had
 * drifted apart: `lua-ui-host` had `UNLOAD_UNIT`/`UNLOAD_UNITS` swapped and `REPEAT`
 * at 55 (which is `SETBASE`), and `train-verification.ts` called 76 `CMD_LOAD_UNITS`
 * and 81 `CMD_UNLOAD_UNITS`. Latent only because nothing in Metalstorm unloaded;
 * `game_transports.lua` activates that surface.
 *
 * So: parse the engine header and require every client name that the header also
 * defines to carry the header's value. Names the header does not define are listed
 * explicitly, so a typo cannot hide as "just an extra".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { CMD, OPT } from './command-buffer';

const HEADER = readFileSync(
    fileURLToPath(new URL('../../../rts/Sim/Units/CommandAI/Command.h', import.meta.url)),
    'utf8');

/** `#define CMD_FOO 42` → `{ FOO: 42 }`. Trailing `//FIXME` comments are ignored. */
function parseDefines(prefix: string): Record<string, number> {
    const out: Record<string, number> = {};
    const re = new RegExp(`^#define\\s+${prefix}([A-Z0-9_]+)\\s+(-?\\d+)`, 'gm');
    for (const m of HEADER.matchAll(re)) out[m[1]] = Number(m[2]);
    return out;
}

const ENGINE_CMD = parseDefines('CMD_');

/** `#define SHIFT_KEY (1 << 5) // 32` → `{ SHIFT_KEY: 32 }`. */
const ENGINE_OPT: Record<string, number> = (() => {
    const out: Record<string, number> = {};
    const re = /^#define\s+([A-Z_]+_(?:KEY|ORDER))\s+\(1 << (\d+)\)/gm;
    for (const m of HEADER.matchAll(re)) out[m[1]] = 1 << Number(m[2]);
    return out;
})();

/** The `CMD.NAME = 123` assignments inside lua-ui-host's `CMD_GLOBALS_LUA` block. */
const LUA_HOST_CMD: Record<string, number> = (() => {
    const src = readFileSync(
        fileURLToPath(new URL('./lua-ui-host.ts', import.meta.url)), 'utf8');
    const block = src.match(/const CMD_GLOBALS_LUA = `([\s\S]*?)`;/);
    if (!block) throw new Error('CMD_GLOBALS_LUA block not found in lua-ui-host.ts');
    const out: Record<string, number> = {};
    for (const m of block[1].matchAll(/\bCMD\.([A-Z0-9_]+)\s*=\s*(\d+)/g)) {
        out[m[1]] = Number(m[2]);
    }
    return out;
})();

/** The `const CMD_NAME = 123;` literals in the train bench. */
const BENCH_CMD: Record<string, number> = (() => {
    const src = readFileSync(
        fileURLToPath(new URL('../scenarios/bench/train-verification.ts', import.meta.url)),
        'utf8');
    const out: Record<string, number> = {};
    for (const m of src.matchAll(/^const CMD_([A-Z0-9_]+) = (\d+);/gm)) {
        out[m[1]] = Number(m[2]);
    }
    return out;
})();

/**
 * Client names the engine header does not define. Each needs a reason: an
 * unexplained entry here is how a typo would slip past the check above.
 */
const NOT_IN_HEADER: Record<string, string> = {
    // command-buffer.ts
    LOOPBACKATTACK: 'legacy Spring id 140; kept for replay/protocol compatibility',
    // lua-ui-host.ts CMD globals
    SET_WANTED_MAX_SPEED: 'legacy Spring id 70, still accepted by MobileCAI',
    // lua-ui-host.ts folds the option bits into the CMD table as CMD.OPT_*
    OPT_META: 'option bit exposed on the Lua CMD table, checked against OPT below',
    OPT_INTERNAL: 'option bit exposed on the Lua CMD table, checked against OPT below',
    OPT_RIGHT: 'option bit exposed on the Lua CMD table, checked against OPT below',
    OPT_SHIFT: 'option bit exposed on the Lua CMD table, checked against OPT below',
    OPT_CTRL: 'option bit exposed on the Lua CMD table, checked against OPT below',
    OPT_ALT: 'option bit exposed on the Lua CMD table, checked against OPT below',
    // train-verification.ts declares the two game_train.lua custom commands
    COUPLE: 'game_train.lua custom command 35001',
    DECOUPLE: 'game_train.lua custom command 35002',
};

/** Assert every name in `table` that the header defines carries the header's value. */
function pin(table: Record<string, number>, label: string) {
    const mismatches: string[] = [];
    const unpinned: string[] = [];
    for (const [name, value] of Object.entries(table)) {
        const engine = ENGINE_CMD[name];
        if (engine === undefined) {
            if (!(name in NOT_IN_HEADER)) unpinned.push(`${name} = ${value}`);
            continue;
        }
        if (engine !== value) mismatches.push(`${name}: ${label} has ${value}, engine has ${engine}`);
    }
    expect(mismatches, `${label} diverges from Command.h`).toEqual([]);
    expect(unpinned, `${label} has names Command.h does not define`).toEqual([]);
}

describe('the engine header parses', () => {
    it('yields the ids this plan turns on', () => {
        // Sanity: if the parse silently produced {} every pin() below would pass.
        expect(ENGINE_CMD.LOAD_UNITS).toBe(75);
        expect(ENGINE_CMD.LOAD_ONTO).toBe(76);
        expect(ENGINE_CMD.UNLOAD_UNITS).toBe(80);
        expect(ENGINE_CMD.UNLOAD_UNIT).toBe(81);
        expect(Object.keys(ENGINE_CMD).length).toBeGreaterThan(30);
    });
});

describe('command-buffer.ts CMD', () => {
    it('matches Command.h', () => pin(CMD as unknown as Record<string, number>, 'command-buffer.ts'));
});

describe('lua-ui-host.ts CMD globals', () => {
    it('matches Command.h', () => pin(LUA_HOST_CMD, 'lua-ui-host.ts'));

    it('agrees with command-buffer.ts on every shared name', () => {
        const buf = CMD as unknown as Record<string, number>;
        const disagreements = Object.keys(LUA_HOST_CMD)
            .filter((k) => k in buf && buf[k] !== LUA_HOST_CMD[k])
            .map((k) => `${k}: lua-ui-host ${LUA_HOST_CMD[k]} vs command-buffer ${buf[k]}`);
        expect(disagreements).toEqual([]);
    });

    it('carries the transport verbs the transports gadget issues', () => {
        expect(LUA_HOST_CMD.LOAD_UNITS).toBe(75);
        expect(LUA_HOST_CMD.LOAD_ONTO).toBe(76);
        expect(LUA_HOST_CMD.UNLOAD_UNITS).toBe(80);
        expect(LUA_HOST_CMD.UNLOAD_UNIT).toBe(81);
    });

    it('exposes the option bits with the engine bit values', () => {
        expect(LUA_HOST_CMD.OPT_META).toBe(ENGINE_OPT.META_KEY);
        expect(LUA_HOST_CMD.OPT_INTERNAL).toBe(ENGINE_OPT.INTERNAL_ORDER);
        expect(LUA_HOST_CMD.OPT_RIGHT).toBe(ENGINE_OPT.RIGHT_MOUSE_KEY);
        expect(LUA_HOST_CMD.OPT_SHIFT).toBe(ENGINE_OPT.SHIFT_KEY);
        expect(LUA_HOST_CMD.OPT_CTRL).toBe(ENGINE_OPT.CONTROL_KEY);
        expect(LUA_HOST_CMD.OPT_ALT).toBe(ENGINE_OPT.ALT_KEY);
    });
});

describe('command-buffer.ts OPT', () => {
    it('matches the engine option bits', () => {
        expect(OPT.META).toBe(ENGINE_OPT.META_KEY);
        expect(OPT.INTERNAL).toBe(ENGINE_OPT.INTERNAL_ORDER);
        expect(OPT.RIGHT).toBe(ENGINE_OPT.RIGHT_MOUSE_KEY);
        expect(OPT.SHIFT).toBe(ENGINE_OPT.SHIFT_KEY);
        expect(OPT.CONTROL).toBe(ENGINE_OPT.CONTROL_KEY);
        expect(OPT.ALT).toBe(ENGINE_OPT.ALT_KEY);
    });
});

describe('train-verification.ts bench constants', () => {
    it('match Command.h', () => pin(BENCH_CMD, 'train-verification.ts'));
});
