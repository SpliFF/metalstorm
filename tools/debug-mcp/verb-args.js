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
