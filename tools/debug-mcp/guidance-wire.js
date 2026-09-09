// guidance-wire.js — the RecvLuaMsg codec `game_ai_guidance.lua` reads, in JS.
//
// A third speaker of ONE dialect: `parley/wire.lua` (the gadget's decoder),
// `client/src/ui/native-ui/guidance-wire.ts` (the browser's encoder), and this
// file (the MCP's encoder). Same rules as the TS mirror: `cmd=name&k=v&…`,
// `% & = ,` percent-escaped as uppercase hex, lists comma-joined, booleans as
// 1/0, nil fields omitted, keys SORTED so the output is byte-stable. The test
// reads the shared fixture file
// (LuaRules/Gadgets/parley/tests/wire-fixtures.tsv) and asserts exact bytes,
// so this encoder cannot drift from the other two without going red.

const RESERVED = /[%&=,]/g;

function escape(value) {
    return String(value).replace(RESERVED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function scalar(value) {
    if (typeof value === 'boolean') return value ? '1' : '0';
    return String(value);
}

/** Encode a command + flat field table. */
export function encodeWire(cmd, fields = {}) {
    const parts = [`cmd=${escape(cmd)}`];
    for (const key of Object.keys(fields).sort()) {
        const value = fields[key];
        if (value === null || value === undefined) continue;
        const encoded = Array.isArray(value)
            ? value.map((item) => escape(scalar(item))).join(',')
            : escape(scalar(value));
        parts.push(`${escape(key)}=${encoded}`);
    }
    return parts.join('&');
}

/** The gadget's own accepted value sets (game_ai_guidance.lua STANCES/PAINTS/ROES). */
export const GUIDANCE_VALUES = {
    stance: ['defensive', 'balanced', 'aggressive'],
    paint: ['priority', 'normal', 'forbidden'],
    roe: ['free', 'observed_only', 'deny_area'],
    lock: ['on', 'off'],
    delegate: ['on', 'off'],
};
export const GUIDANCE_OPS = ['stance', 'paint', 'lock', 'delegate', 'fund', 'roe', 'veto'];

/**
 * One guidance op → {cmd, fields, wire, describe}, or {error}. Field names
 * are the gadget's RecvLuaMsg dispatch names verbatim (regionKey, groupId,
 * locked, objectiveId, delegated, amount, rateCap, goalId).
 */
export function encodeGuidance(g = {}) {
    const make = (cmd, fields, describe) => ({ cmd, fields, wire: encodeWire(cmd, fields), describe });
    const need = (cond, msg) => (cond ? null : { error: msg });
    const enumCheck = (op) => {
        const allowed = GUIDANCE_VALUES[op];
        if (!allowed) return null;
        if (!g.value) {
            if (op === 'lock' || op === 'delegate') return null;   // default 'on'
            return { error: `${op} needs \`value\` — one of ${allowed.join(', ')}` };
        }
        if (!allowed.includes(g.value)) return { error: `${op} value must be one of ${allowed.join(', ')} (got ${JSON.stringify(g.value)})` };
        return null;
    };
    switch (g.op) {
        case 'stance': return enumCheck('stance') || make('guidance.stance', { value: g.value }, `AI stance is now ${g.value}`);
        case 'roe': return enumCheck('roe') || make('guidance.roe', { value: g.value }, `rules of engagement are now ${g.value}`);
        case 'paint':
            return need(g.regionKey, 'paint needs `regionKey` (the region key, not its display name)')
                || enumCheck('paint')
                || make('guidance.paint', { regionKey: g.regionKey, value: g.value },
                    g.value === 'normal' ? `cleared the AI's priority on ${g.regionKey}` : `${g.regionKey} is now ${g.value} for the AI`);
        case 'lock': {
            const err = need(Number.isFinite(g.groupId), 'lock needs a numeric `groupId`') || enumCheck('lock');
            if (err) return err;
            const locked = g.value !== 'off';
            return make('guidance.lock', { groupId: g.groupId, locked }, locked ? `group ${g.groupId} is locked` : `group ${g.groupId} is released`);
        }
        case 'delegate': {
            const err = need(Number.isFinite(g.objectiveId), 'delegate needs a numeric `objectiveId`') || enumCheck('delegate');
            if (err) return err;
            const delegated = g.value !== 'off';
            return make('guidance.delegate', { objectiveId: g.objectiveId, delegated },
                delegated ? `objective ${g.objectiveId} is delegated to the AI` : `objective ${g.objectiveId} is back under the player`);
        }
        case 'fund': {
            if (g.amount == null && g.rateCap == null) return { error: 'fund needs `amount` (one-shot gift from the SENDER\'s own pool) and/or `rateCap` (standing per-minute team allowance)' };
            if (g.amount != null && !(Number.isFinite(g.amount) && g.amount > 0)) return { error: 'fund `amount` must be a positive number' };
            if (g.rateCap != null && !(Number.isFinite(g.rateCap) && g.rateCap >= 0)) return { error: 'fund `rateCap` must be a number >= 0' };
            const bits = [];
            if (g.amount != null) bits.push(`transferred ${g.amount} authority to the team's AI(s)`);
            if (g.rateCap != null) bits.push(`capped the AI allowance at ${g.rateCap}/min`);
            return make('guidance.fund', { amount: g.amount, rateCap: g.rateCap }, bits.join(' and '));
        }
        case 'veto':
            if (g.goalId == null || g.goalId === '') return { error: 'veto needs `goalId` (a planner goal id such as "def:basin_a" or "obj:12")' };
            return make('guidance.veto', { goalId: g.goalId }, `vetoed goal ${g.goalId} for 5 minutes`);
        default:
            return { error: `unknown op ${JSON.stringify(g.op)} — one of ${GUIDANCE_OPS.join(', ')}` };
    }
}

/** Embed an arbitrary string in Lua source as a long-bracket literal. */
export function luaLongString(s) {
    let level = 0;
    while (s.includes(`]${'='.repeat(level)}]`)) level++;
    const eq = '='.repeat(level);
    return `[${eq}[${s}]${eq}]`;
}
