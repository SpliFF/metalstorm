/**
 * lua51-escapes.ts — reproduce Lua 5.1's lenient string-escape handling so that
 * game content authored for Recoil (Lua 5.1) compiles under our Fengari runtime
 * (Lua 5.3).
 *
 * Lua 5.2+ made an unrecognised escape sequence inside a short string literal a
 * compile error; Lua 5.1 silently *drops the backslash* and keeps the following
 * character. Recoil ships Lua 5.1, so BAR's UI code contains literals like
 * `mapName:match'^.*()\ [vV]*'` (lava.lua) and `"^uhe?raf[^\s]*ar?a?$"`
 * (badwords.lua) where `\ ` / `\s` are not valid Lua escapes — under 5.1 they
 * become a literal space / `s`, but Fengari rejects the whole chunk with
 * "invalid escape sequence", so the file (and every widget that depends on it)
 * fails to load.
 *
 * The authoritative behaviour is Recoil's lexer
 * (../RecoilEngine/rts/lib/lua/src/llex.cpp:289-323, `read_string`): on `\`, the
 * backslash is consumed (not saved); for a recognised escape the mapped byte is
 * emitted, for `\<digit>` a `\ddd` numeric escape, and for anything else
 * (`default`, non-digit) only the following character is saved — the backslash
 * vanishes. We mirror exactly that, but ONLY inside short string literals:
 * long-bracket strings (`[[ ]]` / `[==[ ]==]`) and comments do not process
 * escapes, and code outside strings must be left untouched.
 *
 * This is a faithful divergence note: we transform the SOURCE so Fengari yields
 * the same string bytes Recoil's 5.1 lexer would have. The result is identical
 * to Recoil for valid escapes (unchanged) and for invalid ones (backslash
 * dropped) — including the quirk that a buggy `[^\s]` pattern faithfully becomes
 * `[^s]`, exactly as it does on a real Recoil client.
 */

/// Escape characters after `\` that Lua 5.1 recognises and that we must leave
/// intact (backslash preserved): the C-style set, the quote/backslash escapes,
/// and a literal newline (line continuation). `\<digit>` (\ddd) is handled
/// separately. Everything else is an "invalid" escape whose backslash 5.1 drops.
const RECOGNISED_ESCAPE = new Set([
    'a', 'b', 'f', 'n', 'r', 't', 'v',
    '\\', '"', "'",
    '\n', '\r',
]);

/**
 * Rewrite `src` so short-string escape sequences match Lua 5.1 semantics.
 * Pure; returns the input unchanged when it contains no invalid escapes (the
 * common case — so it's safe to run over every compiled chunk).
 */
export function fixLua51Escapes(src: string): string {
    // Fast path: if there's no backslash at all, nothing to do.
    if (src.indexOf('\\') < 0) return src;

    let out = '';
    let i = 0;
    const n = src.length;

    // Detect a long-bracket opener `[`, `=`*, `[` at position p. Returns the
    // level (number of `=`) or -1 if not a long bracket.
    const longOpenLevel = (p: number): number => {
        if (src[p] !== '[') return -1;
        let q = p + 1;
        while (q < n && src[q] === '=') q++;
        return (q < n && src[q] === '[') ? (q - (p + 1)) : -1;
    };

    while (i < n) {
        const ch = src[i];

        // ── comments ──
        if (ch === '-' && src[i + 1] === '-') {
            out += '--';
            i += 2;
            const lvl = longOpenLevel(i);
            if (lvl >= 0) {
                // Long (block) comment: copy verbatim through the matching close.
                const close = `]${'='.repeat(lvl)}]`;
                const end = src.indexOf(close, i);
                if (end < 0) { out += src.slice(i); i = n; }
                else { out += src.slice(i, end + close.length); i = end + close.length; }
            } else {
                // Line comment: copy through end of line.
                let e = i;
                while (e < n && src[e] !== '\n') e++;
                out += src.slice(i, e);
                i = e;
            }
            continue;
        }

        // ── long-bracket string ──
        const openLvl = longOpenLevel(i);
        if (openLvl >= 0) {
            const open = `[${'='.repeat(openLvl)}[`;
            const close = `]${'='.repeat(openLvl)}]`;
            const end = src.indexOf(close, i + open.length);
            if (end < 0) { out += src.slice(i); i = n; }
            else { out += src.slice(i, end + close.length); i = end + close.length; }
            continue;
        }

        // ── short string literal ──
        if (ch === '"' || ch === "'") {
            const delim = ch;
            out += delim;
            i++;
            while (i < n) {
                const c = src[i];
                if (c === '\\') {
                    const e = src[i + 1];
                    if (e === undefined) { out += '\\'; i++; break; }
                    if (RECOGNISED_ESCAPE.has(e) || (e >= '0' && e <= '9')) {
                        // Valid 5.1 escape — keep backslash + char as-is.
                        out += '\\' + e;
                    } else {
                        // Invalid escape — Lua 5.1 drops the backslash.
                        out += e;
                    }
                    i += 2;
                    continue;
                }
                out += c;
                i++;
                if (c === delim) break;          // closing quote
            }
            continue;
        }

        // ── ordinary code ──
        out += ch;
        i++;
    }

    return out;
}
