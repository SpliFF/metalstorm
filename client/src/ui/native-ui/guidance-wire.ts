/**
 * guidance-wire.ts — TS mirror of `parley/wire.lua`'s RecvLuaMsg codec, plus
 * the AIGuidance → guidance-store mapping
 * (PLAN-metalstorm-command-language.md §6.1, milestone M1)
 *
 * `data/games/metalstorm/LuaRules/Gadgets/game_ai_guidance.lua` has been live
 * (`enabled = true`) and listening on `gadget:RecvLuaMsg` since the interaction
 * lane landed, but nothing on the client ever spoke to it: `integration.ts`'s
 * `AIGuidance` case warned "no guidance-store target yet" and dropped the
 * payload. The store existed; the sentence "prioritise Northgate" had no way to
 * reach it. This file is that way.
 *
 * ── THE CODEC (must match parley/wire.lua exactly) ──
 * `cmd=name&key=value&key=value`, with `%`, `&`, `=` and `,` percent-escaped as
 * uppercase two-digit hex, and table values comma-joined. That is a codec
 * game_ai_guidance.lua parses TODAY — the point of this module is to speak it
 * without inventing a second dialect.
 *
 * Two deliberate divergences from the Lua encoder, both safe:
 *   1. **Field order is sorted.** Lua's `pairs()` order is unspecified, so
 *      `Wire.encode` produces field order that varies between runs and between
 *      Lua builds. Sorting the keys here makes the TS output BYTE-STABLE, which
 *      is what lets the shared fixture file pin exact strings. The decoder on
 *      either side is order-insensitive, so this changes nothing on the wire.
 *   2. **Booleans.** Lua has no bool-in-a-query-string convention; this encoder
 *      writes `1`/`0`, which is exactly what the gadget's handlers test
 *      (`fields.locked == '1'`, `fields.delegated ~= '0'`).
 *
 * The cross-language contract is enforced, not asserted: `guidance-wire.test.ts`
 * and `data/games/metalstorm/LuaRules/Gadgets/tests/guidance_wire_spec.lua` load
 * the SAME fixture file (`parley/tests/wire-fixtures.tsv`) — the TS side proves
 * it encodes those exact strings, the Lua side proves `Wire.decode` reads them
 * AND that feeding them to the real gadget moves the real store. Neither side
 * can drift without the other's suite going red.
 */

import type { AIGuidancePayload, CommandVerb } from './compile-table.js';
import { getPriorityBand } from './compile-table.js';
import type { NLGuidanceOp } from './nl-envelope.js';

/** Values the codec accepts for one field. `null`/`undefined` are omitted,
 *  mirroring the Lua encoder's `if v ~= nil`. */
export type WireValue = string | number | boolean | readonly (string | number)[] | null | undefined;

/** Exactly the characters `parley/wire.lua`'s `escape` covers: `[%%&=,]` in Lua
 *  charset syntax is the literal set `% & = ,`. */
const RESERVED = /[%&=,]/g;

function escape(value: string): string {
    return value.replace(RESERVED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function unescape(value: string): string {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function scalar(value: string | number | boolean): string {
    if (typeof value === 'boolean') return value ? '1' : '0';
    return String(value);
}

/**
 * Encode a command + flat field table into a wire string.
 *
 * Keys are emitted in sorted order (see the header) so the output is stable and
 * fixture-pinnable. Table values comma-join, `null`/`undefined` fields are
 * omitted entirely — both matching `Wire.encode`.
 */
export function encodeWire(cmd: string, fields: Record<string, WireValue> = {}): string {
    const parts = [`cmd=${escape(cmd)}`];
    for (const key of Object.keys(fields).sort()) {
        const value = fields[key];
        if (value === null || value === undefined) continue;
        const encoded = Array.isArray(value)
            ? value.map((item) => escape(scalar(item))).join(',')
            : escape(scalar(value as string | number | boolean));
        parts.push(`${escape(key)}=${encoded}`);
    }
    return parts.join('&');
}

/**
 * Decode a wire string into `{ cmd, fields }`. Every value comes back as a
 * STRING — this module has no schema knowledge of which command expects what
 * shape, same contract as `Wire.decode`. `cmd` is null for an empty or
 * malformed string.
 */
export function decodeWire(msg: string): { cmd: string | null; fields: Record<string, string> } {
    const fields: Record<string, string> = {};
    for (const pair of String(msg ?? '').split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq < 1) continue;   // `^([^=]+)=(.*)$` — a key is required
        fields[unescape(pair.slice(0, eq))] = unescape(pair.slice(eq + 1));
    }
    const cmd = fields.cmd ?? null;
    delete fields.cmd;
    return { cmd, fields };
}

/** Split a comma-joined list field back into an array (`Wire.list`). Never
 *  null, so callers can iterate unconditionally. */
export function decodeWireList(value: string | undefined | null): string[] {
    if (!value) return [];
    return value.split(',').filter((item) => item.length > 0);
}

// ───────────────────── guidance ops → the wire ─────────────────────

/**
 * An `NLGuidance` after the resolver has turned every NAME into the id the
 * gadget's handler actually reads. Names never reach the wire — a `regionKey`
 * is the region's key (`region_<key>_name`'s `<key>`), not its display name.
 */
export interface ResolvedGuidance {
    op: NLGuidanceOp;
    value?: string;
    regionKey?: string;
    groupId?: number;
    objectiveId?: number;
    goalId?: number;
    amount?: number;
    rateCap?: number;
}

/** A wire message ready for `sendCommand({type:'LuaRulesMsg'})`, plus the words
 *  the console should echo — the player must be told what the store now says,
 *  not just that "something was sent". */
export interface GuidanceMessage {
    cmd: string;
    fields: Record<string, WireValue>;
    wire: string;
    describe: string;
}

/**
 * Encode one resolved guidance op for `game_ai_guidance.lua`.
 *
 * Field names are the gadget's, verbatim (`regionKey`, `groupId`, `locked`,
 * `objectiveId`, `delegated`, `amount`, `rateCap`, `goalId`) — this mapping is
 * the whole reason the module exists, so it reads them off the gadget's
 * `RecvLuaMsg` dispatch rather than inventing parallel names.
 *
 * Returns null when a required id is missing, so a half-resolved op is refused
 * out loud instead of reaching the gadget as a silent no-op (the gadget's
 * handlers return `false` on a nil id and say nothing).
 */
export function encodeGuidance(g: ResolvedGuidance): GuidanceMessage | null {
    const make = (cmd: string, fields: Record<string, WireValue>, describe: string): GuidanceMessage =>
        ({ cmd, fields, wire: encodeWire(cmd, fields), describe });

    switch (g.op) {
        case 'stance':
            if (!g.value) return null;
            return make('guidance.stance', { value: g.value }, `AI stance is now ${g.value}`);

        case 'roe':
            if (!g.value) return null;
            return make('guidance.roe', { value: g.value },
                `rules of engagement are now ${g.value.replace(/_/g, ' ')}`);

        case 'paint':
            if (!g.regionKey || !g.value) return null;
            return make('guidance.paint', { regionKey: g.regionKey, value: g.value },
                g.value === 'normal'
                    ? `cleared the AI's priority on ${g.regionKey}`
                    : `${g.regionKey} is now ${g.value} for the AI`);

        case 'lock': {
            if (g.groupId == null) return null;
            const locked = g.value !== 'off';
            return make('guidance.lock', { groupId: g.groupId, locked },
                locked
                    ? `group ${g.groupId} is locked — the AI won't touch it`
                    : `group ${g.groupId} is released to the AI`);
        }

        case 'delegate': {
            if (g.objectiveId == null) return null;
            const delegated = g.value !== 'off';
            return make('guidance.delegate', { objectiveId: g.objectiveId, delegated },
                delegated
                    ? `objective ${g.objectiveId} is delegated to the AI`
                    : `objective ${g.objectiveId} is back under your control`);
        }

        case 'fund': {
            if (g.amount == null && g.rateCap == null) return null;
            const bits: string[] = [];
            if (g.amount != null) bits.push(`transferred ${g.amount} authority to the AI`);
            if (g.rateCap != null) bits.push(`capped the AI's spend rate at ${g.rateCap}`);
            return make('guidance.fund', { amount: g.amount, rateCap: g.rateCap }, bits.join(' and '));
        }

        case 'veto':
            if (g.goalId == null) return null;
            return make('guidance.veto', { goalId: g.goalId },
                `vetoed goal ${g.goalId} for the next 5 minutes`);
    }
}

// ───────────── the compile-table's AIGuidance → the store ─────────────

/**
 * Which stance a verb implies, for the fallback below. Coarse by construction:
 * this is the "I heard an order for the AI but you named no region" path.
 */
const VERB_STANCE: Record<CommandVerb, 'aggressive' | 'balanced' | 'defensive'> = {
    attack: 'aggressive',
    secure: 'aggressive',
    scout: 'aggressive',
    defend: 'defensive',
    hold: 'defensive',
    screen: 'defensive',
    patrol: 'defensive',
    escort: 'defensive',
    withdraw: 'defensive',
    reinforce: 'balanced',
    build: 'balanced',
};

/** Entity types whose id IS a region key the guidance store can paint. */
const REGION_LIKE = new Set(['region', 'district', 'city']);

/**
 * Map a `compileIntent()` AIGuidance payload (subject = "the AI") onto a
 * guidance-store write. This is what makes `integration.ts`'s `AIGuidance` case
 * a real send instead of a warn.
 *
 * The mapping is TOTAL — every payload produces a write — because the
 * alternative is the old behaviour: an order the composer reported as committed
 * and the sim never saw.
 *
 *   - target is a region/district/city  → `guidance.paint` on that region key.
 *     `withdraw` paints `forbidden` ("stay out of there"); a low-priority order
 *     paints `normal`, which is the gadget's own way of spelling "no opinion";
 *     anything else paints `priority`.
 *   - no region target (a bare point, or no target at all) → `guidance.stance`
 *     from the verb. Coarser than the player asked for, and the caller echoes
 *     exactly that, but it is a real steer the planner reads rather than a drop.
 *
 * The gadget accepts no coordinates, so a point target genuinely cannot be
 * painted: paint is keyed by region. That limitation is the store's, and this
 * function reports it through `describe` instead of pretending otherwise.
 */
export function aiGuidanceToWire(payload: AIGuidancePayload): GuidanceMessage {
    const entity = payload.targetEntity;
    if (entity && REGION_LIKE.has(entity.type)) {
        const value = payload.verb === 'withdraw' ? 'forbidden'
            : getPriorityBand(payload.priority) === 'low' ? 'normal'
            : 'priority';
        return encodeGuidance({ op: 'paint', regionKey: String(entity.id), value })!;
    }

    const stance = VERB_STANCE[payload.verb] ?? 'balanced';
    const msg = encodeGuidance({ op: 'stance', value: stance })!;
    return {
        ...msg,
        describe: `${msg.describe} (the guidance store paints regions, not coordinates — ` +
                  `"${payload.verb}" became a stance)`,
    };
}
