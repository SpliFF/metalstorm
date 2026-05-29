/**
 * Smoke test: feed the actual ZK ShockWave / SphereDistortion / ShieldJitter
 * fragment shaders through the translator and confirm the output is free
 * of file-scope non-const initializer issues and bracket-mangled indices.
 */
import { describe, it, expect } from 'vitest';
import { translateGLSL } from './glsl-translator';
import * as fs from 'fs';
import * as path from 'path';

function extractFragment(luaPath: string): string {
    const src = fs.readFileSync(luaPath, 'utf8');
    // Two patterns: inline `fragment = [[ ... ]]` (simple classes) and
    // a hoisted `local fsCode = [[ ... ]]` (ShieldSphereColorHQ-style).
    const m = src.match(/fragment\s*=\s*\[\[([\s\S]*?)\]\]/)
           ?? src.match(/local\s+fsCode\s*=\s*\[\[([\s\S]*?)\]\]/);
    if (!m) throw new Error('no fragment block in ' + luaPath);
    return m[1];
}

function extractVertex(luaPath: string): string {
    const src = fs.readFileSync(luaPath, 'utf8');
    const m = src.match(/vertex\s*=\s*\[\[([\s\S]*?)\]\]/)
           ?? src.match(/local\s+vsCode\s*=\s*\[\[([\s\S]*?)\]\]/);
    if (!m) throw new Error('no vertex block in ' + luaPath);
    return m[1];
}

const ZK = '/Users/shannon/WarriorHut/Projects/springrts-web/content/games/zk/lups/ParticleClasses';

describe('LUPS class shaders translate cleanly', () => {
    it('ShockWave FS translates without file-scope non-const init', () => {
        const fs = extractFragment(path.join(ZK, 'ShockWave.lua'));
        const out = translateGLSL(fs, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // p1 / p2 must NOT appear as global initializers — they reference
        // the runtime _legProjectionMatrix uniform.
        expect(out.source).not.toMatch(/^\s*float\s+p1\s*=\s*_leg/m);
        expect(out.source).not.toMatch(/^\s*float\s+p2\s*=\s*_leg/m);
        // Replaced by #define.
        expect(out.source).toMatch(/#define p1 \([^)]*_legProjectionMatrix\[2\]\[2\]\)/);
        expect(out.source).toMatch(/#define p2 \([^)]*_legProjectionMatrix\[2\]\[3\]\)/);
    });

    it('SphereDistortion FS translates without file-scope non-const init', () => {
        const src = extractFragment(path.join(ZK, 'SphereDistortion.lua'));
        const out = translateGLSL(src, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).not.toMatch(/^\s*float\s+p1\s*=\s*_leg/m);
        expect(out.source).not.toMatch(/^\s*float\s+p2\s*=\s*_leg/m);
        expect(out.source).toMatch(/#define p1/);
        expect(out.source).toMatch(/#define p2/);
    });

    it('ShieldJitter FS translates cleanly', () => {
        const src = extractFragment(path.join(ZK, 'ShieldJitter.lua'));
        const out = translateGLSL(src, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
    });

    it('ShieldSphereColorHQ FS keeps integer expressions intact inside array subscripts', () => {
        const src = extractFragment(path.join(ZK, 'ShieldSphereColorHQ.lua'));
        const out = translateGLSL(src, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // The signature pattern that was breaking: hitPoints[5 * idx + N]
        // must remain integer.
        expect(out.source).toMatch(/hitPoints\[5\s*\*\s*hitPointIdx\s*\+\s*0\]/);
        expect(out.source).toMatch(/hitPoints\[5\s*\*\s*hitPointIdx\s*\+\s*3\]/);
        // Defence: no `.0` inside any subscript referencing hitPoints.
        expect(out.source).not.toMatch(/hitPoints\[[^\]]*\.0/);
        // Array declaration size kept integer too: hitPoints[5 * MAX_POINTS]
        expect(out.source).toMatch(/hitPoints\[5\s*\*\s*MAX_POINTS\]/);
        // The HQ FS body has `if (length(offset2) > 0) {` — rule 4b'
        // should promote the integer 0 to 0.0 so the comparison
        // type-checks against length()'s float return.
        expect(out.source).toContain('length(offset2) > 0.0');
        // Same pattern on a different line.
        expect(out.source).toContain('smoothstep(0.0, 0.04, length(offset2))');
    });
});
