// Argument validation for the MCP tool dispatch.
//
// WHY. Every tool here declares an inputSchema, and nothing enforced it: the
// `required` list was decoration. Three failures found in one testing session,
// all of them the same bug wearing different clothes:
//
//   - query_db with no `query` (declared REQUIRED) passed undefined straight
//     into better-sqlite3, which answered "Expected first argument to be a
//     string" — a driver message that names neither the tool nor the field.
//   - give_order with no unitId/cmdId (both REQUIRED) forwarded a malformed
//     verb and returned the game server's raw usage line.
//   - set_los {enabled:true} — the field is `enable` — was read as "no
//     arguments at all", so the tool took its documented omit-means-query
//     branch and replied "ally0=off ally1=off". The caller asked to turn LOS
//     ON and got back something that reads like confirmation it went OFF.
//
// The third is the dangerous one: a typo'd optional field is INDISTINGUISHABLE
// from an intentional omission, so it fails silently and plausibly. Hence the
// near-miss check — an unknown property within a small edit distance of a real
// one is a typo, and typos are errors here rather than ignored extras.
//
// Genuinely unrelated extra properties are still allowed through: no schema
// here sets additionalProperties:false, several handlers read fields the
// schema does not list, and breaking those would be a worse bug than the one
// being fixed.

/** Levenshtein, small-string sized. Used only to spot a near-miss field name. */
export function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
        prev = cur;
    }
    return prev[b.length];
}

/**
 * How close two field names must be to call it a typo rather than an unrelated
 * extra. Scaled to the shorter name so `all` and `pid` (distance 3, both tiny)
 * are not treated as the same word.
 */
function isNearMiss(given, known) {
    const d = editDistance(given.toLowerCase(), known.toLowerCase());
    if (d === 0) return false;
    const shortest = Math.min(given.length, known.length);
    if (shortest <= 4) return d === 1;
    return d <= 2;
}

/**
 * Validate `args` against a tool definition's inputSchema.
 *
 * @returns {string|null} an error message, or null when the call may proceed.
 */
export function validateToolArgs(tool, args) {
    const schema = tool?.inputSchema;
    if (!schema || typeof schema !== 'object') return null;
    const props = schema.properties && typeof schema.properties === 'object'
        ? schema.properties : {};
    const known = Object.keys(props);
    const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

    // 1. Required fields. `null` counts as missing: every one of these is a
    //    number/string/bool, and a null would reach the handler as an absence
    //    anyway — just later, and with a worse message.
    const missing = (Array.isArray(schema.required) ? schema.required : [])
        .filter((k) => given[k] === undefined || given[k] === null);
    if (missing.length) {
        // A plain length cap, not a sentence split: descriptions here are full
        // of "e.g." and "10=MOVE, 20=ATTACK", so splitting on '.' truncated
        // mid-abbreviation ("Spring command ID, e").
        const describe = (k) => {
            const d = props[k]?.description;
            if (!d) return k;
            const s = String(d).trim();
            return `${k} (${s.length > 60 ? `${s.slice(0, 57).trimEnd()}…` : s})`;
        };
        return `${tool.name} requires ${missing.length > 1 ? 'these arguments' : 'the argument'} `
             + `${missing.map(describe).join(', ')}. `
             + (known.length ? `Accepted: ${known.join(', ')}.` : '');
    }

    // 2. Near-miss property names — a silent typo is the failure this exists
    //    for, so it is reported rather than dropped.
    if (known.length) {
        for (const k of Object.keys(given)) {
            if (Object.prototype.hasOwnProperty.call(props, k)) continue;
            const suggestion = known.find((n) => isNearMiss(k, n));
            if (suggestion)
                return `${tool.name} has no argument "${k}" — did you mean "${suggestion}"? `
                     + `An unrecognised name is ignored, which for an optional field is `
                     + `indistinguishable from passing nothing. Accepted: ${known.join(', ')}.`;
        }
    }

    return null;
}
