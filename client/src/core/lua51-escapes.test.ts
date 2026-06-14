import { describe, it, expect } from 'vitest';
import { fixLua51Escapes } from './lua51-escapes.js';

describe('fixLua51Escapes', () => {
    it('returns source unchanged when there is no backslash', () => {
        const src = 'local x = "hello" .. \'world\'';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('drops the backslash for an invalid escape in a double-quoted string', () => {
        // badwords.lua:147 — `\s` is not a Lua escape; 5.1 yields a literal s.
        expect(fixLua51Escapes('"^uhe?raf[^\\s]*ar?a?$"'))
            .toBe('"^uhe?raf[^s]*ar?a?$"');
    });

    it('drops the backslash for an invalid escape in a single-quoted string', () => {
        // lava.lua:75 — `\ ` (backslash-space) becomes a literal space.
        expect(fixLua51Escapes("'^.*()\\ [vV]*[%d%.]+'"))
            .toBe("'^.*() [vV]*[%d%.]+'");
    });

    it('preserves recognised C-style escapes', () => {
        const src = '"a\\tb\\nc\\\\d\\"e"';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('preserves numeric \\ddd escapes', () => {
        const src = '"\\65\\066"';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('does not touch escapes inside long-bracket strings', () => {
        const src = 'local p = [[^.*()\\ [vV]]]';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('does not touch backslashes inside line comments', () => {
        const src = '-- a path C:\\Users\\x not a string\nlocal y = 1';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('does not touch backslashes inside block comments', () => {
        const src = '--[[ regex \\s \\d here ]] local z = 2';
        expect(fixLua51Escapes(src)).toBe(src);
    });

    it('handles multiple strings and mixed valid/invalid escapes', () => {
        expect(fixLua51Escapes('f("\\n\\q", \'\\t\\w\')'))
            .toBe('f("\\nq", \'\\tw\')');
    });

    it('leaves a trailing lone backslash alone', () => {
        // Degenerate; Fengari will report unfinished string, but we must not crash.
        expect(fixLua51Escapes('"abc\\')).toBe('"abc\\');
    });

    it('keeps code containing escaped quotes balanced', () => {
        const src = 'x = "a\\"b" .. "\\w"';
        expect(fixLua51Escapes(src)).toBe('x = "a\\"b" .. "w"');
    });
});
