// verb-args.js — argument hygiene for the game server's `server` exec verbs.
//
// The MCP builds verb strings like `spawn <def> <x> <z> <team> <count>` and
// `order <unit> <cmd> <params…> <opts>` by template. The exec channel is not a
// shell, so this is not shell injection — but a defName carrying whitespace or
// a NaN coordinate still produces a verb the server parses as something else
// (an extra positional token shifts every field to its right), and the failure
// reads as a mysterious usage line. Refuse such values HERE, by name, before
// the string exists.

export class VerbArgError extends Error {}

const TOKEN = /^[A-Za-z0-9_.:\-]+$/;

/** One positional token. Numbers must be finite; strings must be a single
 *  bare word (def names, `all`, `on`/`off`, a goal id). */
export function verbToken(value, name) {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new VerbArgError(`${name} must be a finite number (got ${value})`);
        return String(value);
    }
    if (typeof value === 'boolean') return value ? '1' : '0';
    if (typeof value === 'string') {
        if (!TOKEN.test(value)) {
            throw new VerbArgError(`${name} must be a single bare token (letters, digits, _ . : -), got ${JSON.stringify(value)}`);
        }
        return value;
    }
    throw new VerbArgError(`${name} must be a number or string (got ${value === null ? 'null' : typeof value})`);
}

/** A numeric token — the common case for unit ids, counts, coordinates. */
export function numToken(value, name) {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) value = Number(value);
    if (typeof value !== 'number') throw new VerbArgError(`${name} must be a number (got ${JSON.stringify(value)})`);
    return verbToken(value, name);
}

/** An integer token — unit ids, command ids, coded option bits. */
export function intToken(value, name) {
    const s = numToken(value, name);
    if (!Number.isInteger(Number(s))) throw new VerbArgError(`${name} must be an integer (got ${JSON.stringify(value)})`);
    return s;
}

/**
 * A unit order as a literal `Spring.GiveOrderToUnit` call for the LuaRules
 * exec scope — NOT the server's `order` verb.
 *
 * The `order <unit> <cmd> [params…] [opts]` verb only honours a trailing opts
 * when EXACTLY four params precede it (rts/Server/LuaExecEngine.cpp: "if
 * exactly 5 numbers remain after cmdId, the last is opts"). A 3-param MOVE
 * with SHIFT — `order u 10 x 0 z 32` — is therefore parsed as a 4-param MOVE
 * with opts 0: every "queued" waypoint silently REPLACED the last, and the
 * first live `drive_pattern` call reached 0 of its 8 waypoints. In Lua the
 * params table and the opts argument cannot be confused for one another.
 */
export function buildOrderLua(unitId, cmdId, params = [], opts = 0) {
    const u = intToken(unitId, 'unitId');
    if (Number(u) <= 0) throw new VerbArgError(`unitId must be positive (got ${unitId})`);
    const c = intToken(cmdId, 'cmdId');
    const o = intToken(opts ?? 0, 'opts');
    if (Number(o) < 0) throw new VerbArgError(`opts must be a non-negative coded option mask (got ${opts})`);
    if (!Array.isArray(params)) throw new VerbArgError('params must be an array');
    if (params.length > 4) throw new VerbArgError(`at most 4 params per order (got ${params.length})`);
    const p = params.map((v, i) => numToken(v, `params[${i}]`));
    return `Spring.GiveOrderToUnit(${u}, ${c}, {${p.join(', ')}}, ${o})\nreturn 'order ${c} issued to ${u}'`;
}

/** Assemble a verb from validated parts. `parts` is [[value, name, kind?], …]
 *  where kind 'num' forces a numeric token. Undefined/null parts are skipped
 *  (optional trailing arguments). */
export function buildVerb(verb, parts) {
    const out = [verb];
    for (const [value, name, kind] of parts) {
        if (value === undefined || value === null) continue;
        out.push(kind === 'num' ? numToken(value, name) : verbToken(value, name));
    }
    return out.join(' ');
}
