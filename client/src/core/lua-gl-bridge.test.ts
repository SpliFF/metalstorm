import { describe, it, expect } from 'vitest';
import {
    groundCircleVertices,
    internUniformLocation,
    resolveRegisteredLocation,
    normaliseTexturePath,
    isGameAssetPath,
    atmosphereReturn,
    textureCacheDumpRows,
    type LuaTextureHandle,
} from './lua-gl-bridge.js';
import { defaultMapAtmosphere } from './map-lighting.js';

/** Build a texture-cache handle for the dump tests (tex ref is irrelevant). */
function texHandle(
    width: number,
    height: number,
    diag?: LuaTextureHandle['diag'],
): LuaTextureHandle {
    return { __type: 'texture', tex: {} as WebGLTexture, width, height, diag };
}

describe('normaliseTexturePath (Spring texture-spec modifier stripping)', () => {
    it('passes a plain path through unchanged', () => {
        expect(normaliseTexturePath('LuaUI/Images/metal.png')).toBe('LuaUI/Images/metal.png');
    });
    it('strips a single-flag modifier :l:', () => {
        expect(normaliseTexturePath(':l:LuaUI/Images/barglow-center.png'))
            .toBe('LuaUI/Images/barglow-center.png');
    });
    it('strips a multi-flag + resize modifier :lr104,104: (the BAR top-bar icon bug)', () => {
        // Previously the <8 closing-colon cap left this prefix in place, so the
        // path failed the luaui/ game-asset test and 404'd against the map base.
        expect(normaliseTexturePath(':lr104,104:LuaUI/Images/metal.png'))
            .toBe('LuaUI/Images/metal.png');
        expect(normaliseTexturePath(':lr256,256:LuaUI/Images/energy.png'))
            .toBe('LuaUI/Images/energy.png');
    });
    it('strips a tint modifier :t1,0,0:', () => {
        expect(normaliseTexturePath(':t1,0,0:bitmaps/x.png')).toBe('bitmaps/x.png');
    });
    it('normalises backslashes and a leading slash', () => {
        expect(normaliseTexturePath('\\LuaUI\\Images\\x.png')).toBe('LuaUI/Images/x.png');
        expect(normaliseTexturePath('/LuaUI/Images/x.png')).toBe('LuaUI/Images/x.png');
    });
    it('leaves a build-pic ref (#123) and short names alone', () => {
        expect(normaliseTexturePath('#123')).toBe('#123');
        expect(normaliseTexturePath('tech_overlaywindow.png')).toBe('tech_overlaywindow.png');
    });
});

describe('isGameAssetPath (game vs map asset base selection)', () => {
    it('treats LuaUI/luarules/bitmaps/unittextures roots as game assets', () => {
        expect(isGameAssetPath('luaui/images/metal.png')).toBe(true);
        expect(isGameAssetPath('bitmaps/foo.png')).toBe(true);
        expect(isGameAssetPath('unittextures/arm_color.dds')).toBe(true);
    });
    it('treats icons/ as a game asset (BAR icons/blank.png — was 404 vs map base)', () => {
        expect(isGameAssetPath('icons/blank.png')).toBe(true);
    });
    it('treats unknown roots as non-game (resolve against the map)', () => {
        expect(isGameAssetPath('detail/grass.png')).toBe(false);
        expect(isGameAssetPath('somemap/splat.png')).toBe(false);
    });
});

describe('atmosphereReturn (gl.GetAtmosphere)', () => {
    const DIR: [number, number, number] = [0.5, -0.7, 0.5];
    const A = defaultMapAtmosphere();

    it('returns the light direction for no param and "pos"', () => {
        expect(atmosphereReturn(A, DIR)).toEqual([0.5, -0.7, 0.5]);
        expect(atmosphereReturn(A, DIR, '')).toEqual([0.5, -0.7, 0.5]);
        expect(atmosphereReturn(A, DIR, 'pos')).toEqual([0.5, -0.7, 0.5]);
    });

    it('returns a single number for fogStart/fogEnd (the gui_options crash path)', () => {
        // The widget compares `fogEnd <= fogStart`; both must be numbers, not nil.
        const fogEnd = atmosphereReturn(A, DIR, 'fogEnd');
        const fogStart = atmosphereReturn(A, DIR, 'fogStart');
        expect(typeof fogEnd).toBe('number');
        expect(typeof fogStart).toBe('number');
        expect(fogEnd as number <= (fogStart as number)).toBe(false); // 1.0 > 0.1
    });

    it('returns float3/float4 component arrays for the colours', () => {
        expect(atmosphereReturn(A, DIR, 'fogColor')).toEqual([0.7, 0.7, 0.8, 1.0]);
        expect(atmosphereReturn(A, DIR, 'skyColor')).toEqual([0.1, 0.15, 0.7]);
        expect(atmosphereReturn(A, DIR, 'sunColor')).toEqual([1, 1, 1]);
        expect(atmosphereReturn(A, DIR, 'cloudColor')).toEqual([1, 1, 1]);
        expect(atmosphereReturn(A, DIR, 'skyAxisAngle')).toEqual([0, 0, 1, 0]);
    });

    it('returns undefined for an unknown param (Recoil pushes nothing)', () => {
        expect(atmosphereReturn(A, DIR, 'bogus')).toBeUndefined();
    });

    it('reflects an updated store (Set/Get round-trip)', () => {
        const a = defaultMapAtmosphere();
        a.fogStart = 0.5;
        a.fogColor = [0.1, 0.2, 0.3, 0.4];
        expect(atmosphereReturn(a, DIR, 'fogStart')).toBe(0.5);
        expect(atmosphereReturn(a, DIR, 'fogColor')).toEqual([0.1, 0.2, 0.3, 0.4]);
    });
});

describe('textureCacheDumpRows (UI-1b texture-cache introspection)', () => {
    it('reports a loaded texture: real dims, loaded=true, not a placeholder', () => {
        const cache = new Map<string, LuaTextureHandle>([
            ['luaui/images/metal.png', texHandle(104, 104, {
                resolvedUrl: 'http://x/game/luaui/images/metal.png',
                loadedUrl: 'http://x/game/luaui/images/metal.png',
                loaded: true, lastError: '',
            })],
        ]);
        const [row] = textureCacheDumpRows(cache);
        expect(row.key).toBe('luaui/images/metal.png');
        expect(row.width).toBe(104);
        expect(row.loaded).toBe(true);
        expect(row.placeholder).toBe(false);
        expect(row.loadedUrl).toBe('http://x/game/luaui/images/metal.png');
        expect(row.lastError).toBe('');
    });

    it('flags the still-magenta 1×1 placeholder (the U3 root-cause signal)', () => {
        const cache = new Map<string, LuaTextureHandle>([
            ['luaui/images/energy.png', texHandle(1, 1, {
                resolvedUrl: 'http://x/game/luaui/images/energy.png',
                loadedUrl: '', loaded: false, lastError: 'HTTP 404',
            })],
        ]);
        const [row] = textureCacheDumpRows(cache);
        expect(row.loaded).toBe(false);
        expect(row.placeholder).toBe(true);
        expect(row.lastError).toBe('HTTP 404');
        // resolvedUrl is still visible even though nothing loaded — the whole
        // point of the instrumentation is to see WHERE it tried to load from.
        expect(row.resolvedUrl).toBe('http://x/game/luaui/images/energy.png');
    });

    it('records a winning fallback URL distinct from the resolved URL', () => {
        const cache = new Map<string, LuaTextureHandle>([
            ['#42', texHandle(64, 64, {
                resolvedUrl: 'http://x/game/unitpics/CommRecon.png',
                loadedUrl: 'http://x/game/unitpics/commrecon.png', // case-fallback won
                loaded: true, lastError: '',
            })],
        ]);
        const [row] = textureCacheDumpRows(cache);
        expect(row.loaded).toBe(true);
        expect(row.loadedUrl).not.toBe(row.resolvedUrl);
        expect(row.loadedUrl).toBe('http://x/game/unitpics/commrecon.png');
    });

    it('substring-filters keys case-insensitively', () => {
        const cache = new Map<string, LuaTextureHandle>([
            ['luaui/images/metal.png', texHandle(104, 104)],
            ['luaui/images/energy.png', texHandle(104, 104)],
            ['bitmaps/detailtex.png', texHandle(256, 256)],
        ]);
        expect(textureCacheDumpRows(cache, 'METAL').map((r) => r.key)).toEqual([
            'luaui/images/metal.png',
        ]);
        expect(textureCacheDumpRows(cache, 'images').length).toBe(2);
    });

    it('falls back to size heuristics when a diag is absent (legacy entries)', () => {
        const cache = new Map<string, LuaTextureHandle>([
            ['a.png', texHandle(128, 128)], // no diag → loaded inferred from size
            ['b.png', texHandle(1, 1)],     // 1×1 no diag → placeholder
        ]);
        const rows = textureCacheDumpRows(cache);
        expect(rows.find((r) => r.key === 'a.png')?.loaded).toBe(true);
        expect(rows.find((r) => r.key === 'b.png')?.placeholder).toBe(true);
    });
});

describe('groundCircleVertices (gl.DrawGroundCircle geometry)', () => {
    it('emits exactly `divs` vertices (3 floats each)', () => {
        const v = groundCircleVertices(0, 0, 0, 100, 24, null);
        expect(v.length).toBe(24 * 3);
    });

    it('places points on the circle of the given radius around the centre', () => {
        const cx = 500, cz = 300, r = 128;
        const v = groundCircleVertices(cx, 0, cz, r, 32, null);
        for (let i = 0; i < v.length; i += 3) {
            const dx = v[i] - cx;
            const dz = v[i + 2] - cz;
            expect(Math.hypot(dx, dz)).toBeCloseTo(r, 4);
        }
    });

    it('uses the flat fallback Y when no sampler is wired', () => {
        const v = groundCircleVertices(0, 42, 0, 50, 8, null);
        for (let i = 1; i < v.length; i += 3) expect(v[i]).toBe(42);
    });

    it('lifts each vertex to the sampled terrain height', () => {
        // sampler returns a height that depends on x so we can tell vertices apart
        const sample = (x: number, _z: number) => x * 0.5;
        const v = groundCircleVertices(0, 999, 0, 200, 12, sample);
        for (let i = 0; i < v.length; i += 3) {
            expect(v[i + 1]).toBeCloseTo(v[i] * 0.5, 6);
        }
        // and never the flat fallback
        expect(v.some((_, i) => i % 3 === 1 && v[i] === 999)).toBe(false);
    });

    it('starts at the +Z point (angle 0 → sin 0, cos 1)', () => {
        const v = groundCircleVertices(10, 0, 20, 64, 16, null);
        expect(v[0]).toBeCloseTo(10, 6);     // x = px + r·sin(0)
        expect(v[2]).toBeCloseTo(20 + 64, 6); // z = pz + r·cos(0)
    });
});

describe('uniform location interning (gl.GetUniformLocation)', () => {
    // String sentinels stand in for opaque WebGLUniformLocation objects.
    it('allocates sequential ids and indexes the global registry', () => {
        const reg: (string | null)[] = [];
        const locIds = new Map<string, number>();
        const a = internUniformLocation(locIds, reg, 'uColor', () => 'LOC_uColor');
        const b = internUniformLocation(locIds, reg, 'uTime', () => 'LOC_uTime');
        expect(a).toBe(0);
        expect(b).toBe(1);
        expect(resolveRegisteredLocation(reg, a)).toBe('LOC_uColor');
        expect(resolveRegisteredLocation(reg, b)).toBe('LOC_uTime');
    });

    it('dedupes repeat lookups of the same name to one id/slot', () => {
        const reg: (string | null)[] = [];
        const locIds = new Map<string, number>();
        let resolves = 0;
        const r = () => { resolves++; return 'LOC'; };
        const first = internUniformLocation(locIds, reg, 'uColor', r);
        const again = internUniformLocation(locIds, reg, 'uColor', r);
        expect(again).toBe(first);
        expect(reg.length).toBe(1);
        expect(resolves).toBe(1); // resolver only called once
    });

    it('mirrors GL -1 for unknown uniforms without burning a slot', () => {
        const reg: (string | null)[] = [];
        const locIds = new Map<string, number>();
        const id = internUniformLocation(locIds, reg, 'uMissing', () => null);
        expect(id).toBe(-1);
        expect(reg.length).toBe(0);
        // cached: a second lookup is still -1 and still doesn't allocate
        expect(internUniformLocation(locIds, reg, 'uMissing', () => 'LATE')).toBe(-1);
        expect(reg.length).toBe(0);
    });

    it('resolves out-of-range / negative ids to null', () => {
        const reg: (string | null)[] = ['L0', 'L1'];
        expect(resolveRegisteredLocation(reg, -1)).toBeNull();
        expect(resolveRegisteredLocation(reg, 2)).toBeNull();
        expect(resolveRegisteredLocation(reg, 0)).toBe('L0');
    });
});
