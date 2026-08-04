/**
 * guidance-wire.test.ts — the codec, pinned to the bytes Lua parses
 * (PLAN-metalstorm-command-language.md §8 "codec cross-test")
 *
 * The fixture strings come from `parley/tests/wire-fixtures.tsv`, which
 * `LuaRules/Gadgets/tests/guidance_wire_spec.lua` reads too: this side asserts TS
 * ENCODES those exact bytes, that side asserts Lua DECODES them and that
 * `game_ai_guidance.lua` moves its store when it gets them. Neither encoder can
 * drift without one of the two suites failing — which is the only reason to trust
 * a client-side mirror of a Lua codec at all.
 */

import { describe, it, expect } from 'vitest';
import {
    encodeWire, decodeWire, decodeWireList, encodeGuidance, aiGuidanceToWire,
} from './guidance-wire.js';
import type { AIGuidancePayload } from './compile-table.js';
import { loadWireFixtures } from './nl-fixtures/load-fixtures.test-support.js';

const fixtures = loadWireFixtures();

describe('the shared TS/Lua fixtures', () => {
    it('loaded', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(20);
    });

    for (const fixture of fixtures) {
        it(`encodes ${fixture.wire}`, () => {
            expect(encodeWire(fixture.cmd, fixture.fields)).toBe(fixture.wire);
        });

        it(`decodes ${fixture.wire}`, () => {
            const { cmd, fields } = decodeWire(fixture.wire);
            expect(cmd).toBe(fixture.cmd);
            for (const [key, value] of Object.entries(fixture.fields)) {
                // A list arrives comma-joined; `decodeWireList` is what splits it,
                // exactly as `Wire.list` does on the Lua side.
                expect(Array.isArray(value) ? decodeWireList(fields[key]) : fields[key]).toEqual(value);
            }
            expect(Object.keys(fields).sort()).toEqual(Object.keys(fixture.fields).sort());
        });
    }

    it('exercises all four escaped characters', () => {
        // Without this, a fixture set of plain alphanumerics would pass any
        // encoder — including one that escapes nothing.
        const values = fixtures.flatMap((f) => Object.values(f.fields)).flat().join('');
        for (const char of ['%', '&', '=', ',']) {
            expect(values, `no fixture value contains ${char}`).toContain(char);
        }
    });
});

describe('the codec matches parley/wire.lua', () => {
    it('escapes exactly %, &, = and , — and nothing else', () => {
        // Lua's `escape` covers the charset `[%%&=,]`. Spaces, slashes, quotes
        // and unicode pass through untouched; escaping more would produce bytes
        // the Lua decoder unescapes into different text.
        expect(encodeWire('c', { v: 'a b/c"dé' })).toBe('cmd=c&v=a b/c"dé');
        expect(encodeWire('c', { v: '%&=,' })).toBe('cmd=c&v=%25%26%3D%2C');
    });

    it('uses uppercase two-digit hex, as string.format("%%%02X") does', () => {
        expect(encodeWire('c', { v: ',' })).toBe('cmd=c&v=%2C');
        expect(encodeWire('c', { v: ',' })).not.toContain('%2c');
    });

    it('omits null and undefined fields entirely', () => {
        expect(encodeWire('c', { a: 1, b: null, d: undefined })).toBe('cmd=c&a=1');
    });

    it('keeps an empty string as a present-but-empty field', () => {
        // `'' ~= nil` in Lua, so the Lua encoder keeps it too.
        expect(encodeWire('c', { a: '' })).toBe('cmd=c&a=');
        expect(decodeWire('cmd=c&a=').fields.a).toBe('');
    });

    it('writes booleans as 1/0, which is what the gadget tests for', () => {
        expect(encodeWire('c', { on: true, off: false })).toBe('cmd=c&off=0&on=1');
    });

    it('comma-joins a list rather than escaping its commas', () => {
        expect(encodeWire('c', { list: ['a', 'b'] })).toBe('cmd=c&list=a,b');
        expect(encodeWire('c', { str: 'a,b' })).toBe('cmd=c&str=a%2Cb');
    });

    it('sorts field order so the output is byte-stable', () => {
        expect(encodeWire('c', { z: 1, a: 2 })).toBe(encodeWire('c', { a: 2, z: 1 }));
        expect(encodeWire('c', { z: 1, a: 2 })).toBe('cmd=c&a=2&z=1');
    });

    it('round-trips values containing every reserved character', () => {
        const fields = { a: 'pay & obey, or=else', b: '100%' };
        expect(decodeWire(encodeWire('x', fields)).fields).toEqual(fields);
    });

    it('yields a null cmd for empty or garbage input', () => {
        expect(decodeWire('').cmd).toBeNull();
        expect(decodeWire('no-equals-here').cmd).toBeNull();
        expect(decodeWire('=novalue').cmd).toBeNull();
    });

    it('is order-insensitive on decode', () => {
        expect(decodeWire('value=priority&cmd=guidance.paint&regionKey=k'))
            .toEqual({ cmd: 'guidance.paint', fields: { regionKey: 'k', value: 'priority' } });
    });

    it('splits a list field, and never returns null', () => {
        expect(decodeWireList('a,b,c')).toEqual(['a', 'b', 'c']);
        expect(decodeWireList('')).toEqual([]);
        expect(decodeWireList(undefined)).toEqual([]);
    });
});

describe('encodeGuidance', () => {
    it('maps every op onto the gadget field names', () => {
        expect(encodeGuidance({ op: 'stance', value: 'aggressive' })!.wire)
            .toBe('cmd=guidance.stance&value=aggressive');
        expect(encodeGuidance({ op: 'roe', value: 'deny_area' })!.wire)
            .toBe('cmd=guidance.roe&value=deny_area');
        expect(encodeGuidance({ op: 'paint', regionKey: 'k', value: 'priority' })!.wire)
            .toBe('cmd=guidance.paint&regionKey=k&value=priority');
        expect(encodeGuidance({ op: 'lock', groupId: 3, value: 'on' })!.wire)
            .toBe('cmd=guidance.lock&groupId=3&locked=1');
        expect(encodeGuidance({ op: 'delegate', objectiveId: 7, value: 'off' })!.wire)
            .toBe('cmd=guidance.delegate&delegated=0&objectiveId=7');
        expect(encodeGuidance({ op: 'fund', amount: 50, rateCap: 10 })!.wire)
            .toBe('cmd=guidance.fund&amount=50&rateCap=10');
        expect(encodeGuidance({ op: 'veto', goalId: 4 })!.wire)
            .toBe('cmd=guidance.veto&goalId=4');
    });

    it('defaults lock/delegate to ON when no value is given', () => {
        // The gadget reads `locked == '1'` and `delegated ~= '0'`; "lock Chimera"
        // with no explicit on/off means lock it.
        expect(encodeGuidance({ op: 'lock', groupId: 1 })!.wire).toContain('locked=1');
        expect(encodeGuidance({ op: 'delegate', objectiveId: 1 })!.wire).toContain('delegated=1');
    });

    it('returns null rather than a message the gadget would silently drop', () => {
        // The gadget's handlers `return false` on a nil id and say nothing, so a
        // half-resolved op must be refused here where it can still be reported.
        expect(encodeGuidance({ op: 'paint', value: 'priority' })).toBeNull();
        expect(encodeGuidance({ op: 'lock' })).toBeNull();
        expect(encodeGuidance({ op: 'delegate' })).toBeNull();
        expect(encodeGuidance({ op: 'veto' })).toBeNull();
        expect(encodeGuidance({ op: 'fund' })).toBeNull();
        expect(encodeGuidance({ op: 'stance' })).toBeNull();
    });

    it('describes what the store now holds, not what was sent', () => {
        expect(encodeGuidance({ op: 'paint', regionKey: 'osprey_fen', value: 'normal' })!.describe)
            .toContain("cleared the AI's priority");
        expect(encodeGuidance({ op: 'lock', groupId: 2, value: 'off' })!.describe)
            .toContain('released to the AI');
        expect(encodeGuidance({ op: 'roe', value: 'observed_only' })!.describe)
            .toContain('observed only');
    });
});

describe('aiGuidanceToWire — the compile table\'s AIGuidance payload', () => {
    const payload = (over: Partial<AIGuidancePayload> = {}): AIGuidancePayload => ({
        intent: 'x', verb: 'secure', priority: 75, ...over,
    });

    it('paints the region when the target is one', () => {
        const message = aiGuidanceToWire(payload({
            targetEntity: { id: 'north_gate_ridge', type: 'region' },
        }));
        expect(message.wire).toBe('cmd=guidance.paint&regionKey=north_gate_ridge&value=priority');
    });

    it('paints a city or district too — both are region keys in the store', () => {
        for (const type of ['city', 'district']) {
            expect(aiGuidanceToWire(payload({ targetEntity: { id: 'k', type } })).cmd)
                .toBe('guidance.paint');
        }
    });

    it('paints forbidden for withdraw — "stay out of there"', () => {
        expect(aiGuidanceToWire(payload({
            verb: 'withdraw', targetEntity: { id: 'k', type: 'region' },
        })).wire).toContain('value=forbidden');
    });

    it("paints normal at low priority — the gadget's own way to say 'no opinion'", () => {
        expect(aiGuidanceToWire(payload({
            priority: 25, targetEntity: { id: 'k', type: 'region' },
        })).wire).toContain('value=normal');
    });

    it('falls back to a stance when there is no region to paint', () => {
        // The store paints regions, not coordinates. A bare point can genuinely
        // not be painted — so the verb becomes a stance and the echo says so,
        // rather than the payload being dropped the way it used to be.
        const message = aiGuidanceToWire(payload({ verb: 'attack', targetPoint: { x: 1, z: 2 } }));
        expect(message.wire).toBe('cmd=guidance.stance&value=aggressive');
        expect(message.describe).toContain('paints regions, not coordinates');
    });

    it('maps defensive verbs to a defensive stance', () => {
        for (const verb of ['defend', 'hold', 'screen', 'patrol', 'escort', 'withdraw'] as const) {
            expect(aiGuidanceToWire(payload({ verb })).wire).toBe('cmd=guidance.stance&value=defensive');
        }
    });

    it('maps build/reinforce to balanced', () => {
        for (const verb of ['build', 'reinforce'] as const) {
            expect(aiGuidanceToWire(payload({ verb })).wire).toBe('cmd=guidance.stance&value=balanced');
        }
    });

    it('never returns nothing — the mapping is total, so integration.ts has no drop path', () => {
        const verbs = ['attack', 'secure', 'defend', 'hold', 'patrol', 'screen',
                       'scout', 'escort', 'withdraw', 'reinforce', 'build'] as const;
        for (const verb of verbs) {
            for (const target of [
                undefined,
                { targetPoint: { x: 0, z: 0 } },
                { targetEntity: { id: 'k', type: 'region' } },
                { targetEntity: { id: 42, type: 'objective' } },
            ]) {
                const message = aiGuidanceToWire(payload({ verb, ...target }));
                expect(message.wire.startsWith('cmd=guidance.')).toBe(true);
                expect(decodeWire(message.wire).cmd).toBeTruthy();
            }
        }
    });

    it('an objective target has no region key, so it becomes a stance', () => {
        // Honest limitation: the guidance store's paint is keyed by region, and an
        // objective id is not a region key. Painting under the objective's id
        // would write a key the AI never reads.
        expect(aiGuidanceToWire(payload({ targetEntity: { id: 3, type: 'objective' } })).cmd)
            .toBe('guidance.stance');
    });
});
