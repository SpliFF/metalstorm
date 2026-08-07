import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';
import {
    TerrainSplatPlugin, attachTerrainSplat, attachTerrainDetailPlain,
    SMF_DETAILTEX_RES,
} from './terrain-splat-plugin.js';

// The shading itself needs a real GL context to observe; what is asserted here
// is the wiring a live run then depends on — that the two branches of Recoil's
// GetDetailTextureColor (splat / plain, PLAN-terrain-detailtex.md §2.1) are
// selected by mutually exclusive defines, that each declares the sampler its
// shader branch reads, and that the attach helpers pick the intended mode. The
// mutual exclusivity is the invariant worth a test: a material carrying both
// would double-add signed detail and brighten the ground.

describe('TerrainSplatPlugin', () => {
    function make(): { plugin: TerrainSplatPlugin; mat: StandardMaterial } {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const mat = new StandardMaterial('m', scene);
        return { plugin: new TerrainSplatPlugin(mat), mat };
    }
    const tex = (name: string): BaseTexture =>
        ({ name } as unknown as BaseTexture);
    const defines = (plugin: TerrainSplatPlugin): Record<string, boolean> => {
        const d = { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false };
        plugin.prepareDefines(d);
        return d;
    };

    it('defaults to splat mode and to disabled', () => {
        const { plugin } = make();
        expect(plugin.mode).toBe('splat');
        expect(plugin.isEnabled).toBe(false);
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false });
    });

    it('enables exactly one define per mode, never both', () => {
        const { plugin } = make();
        plugin.isEnabled = true;
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: true, TERRAIN_DETAIL_PLAIN: false });
        plugin.mode = 'plain';
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: true });
    });

    it('drops both defines when disabled in either mode', () => {
        const { plugin } = make();
        plugin.mode = 'plain';
        plugin.isEnabled = true;
        plugin.isEnabled = false;
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false });
    });

    it('declares the samplers both shader branches read', () => {
        const samplers: string[] = [];
        make().plugin.getSamplers(samplers);
        expect(samplers).toContain('splatDistrTex');
        expect(samplers).toContain('splatDetailTex');
        expect(samplers).toContain('plainDetailTex');
    });

    it('guards each fragment branch behind its own define', () => {
        const code = make().plugin.getCustomCode('fragment');
        expect(code).not.toBeNull();
        const defs = code!.CUSTOM_FRAGMENT_DEFINITIONS;
        const body = code!.CUSTOM_FRAGMENT_BEFORE_LIGHTS;
        expect(defs).toContain('#ifdef TERRAIN_SPLAT');
        expect(defs).toContain('#ifdef TERRAIN_DETAIL_PLAIN');
        expect(defs).toContain('uniform sampler2D plainDetailTex;');
        expect(body).toContain('#ifdef TERRAIN_DETAIL_PLAIN');
        // Signed centring: mid-grey contributes zero, which is what makes the
        // mip chain the distance falloff (no fade uniform anywhere).
        expect(body).toContain('texture(plainDetailTex, _pdUV).rgb * 2.0 - 1.0');
        expect(body).toContain('baseColor.rgb += _pdCol;');
        // World-XZ at Recoil's fixed SMF_DETAILTEX_RES, not mesh UVs — that is
        // why it is seamless across terrain chunks and atlas pages.
        expect(body).toContain(`vPositionW.xz * vec2(${SMF_DETAILTEX_RES})`);
        expect(SMF_DETAILTEX_RES).toBe(0.02);
    });

    it('emits no vertex-stage code', () => {
        expect(make().plugin.getCustomCode('vertex')).toBeNull();
    });

    it('attachTerrainSplat configures splat mode', () => {
        const { mat } = make();
        const p = attachTerrainSplat(
            mat, tex('distr'), tex('detail'),
            [0.02, 0.03, 0.04, 0.05], [1, 1, 1, 0.5], 8192, 4096);
        expect(p.mode).toBe('splat');
        expect(p.isEnabled).toBe(true);
        expect(p.plainDetailTexture).toBeNull();
        expect(p.texScales).toEqual([0.02, 0.03, 0.04, 0.05]);
        expect(p.worldW).toBe(8192);
        expect(defines(p)).toEqual(
            { TERRAIN_SPLAT: true, TERRAIN_DETAIL_PLAIN: false });
    });

    it('attachTerrainDetailPlain configures plain mode with no splat textures', () => {
        const { mat } = make();
        const p = attachTerrainDetailPlain(mat, tex('detail'));
        expect(p.mode).toBe('plain');
        expect(p.isEnabled).toBe(true);
        expect(p.plainDetailTexture).not.toBeNull();
        expect(p.distrTexture).toBeNull();
        expect(p.detailTexture).toBeNull();
        expect(defines(p)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: true });
    });

    it('binds only the plain sampler and no uniforms in plain mode', () => {
        const { mat } = make();
        const p = attachTerrainDetailPlain(mat, tex('detail'));
        const bound: string[] = [];
        const updated: string[] = [];
        p.bindForSubMesh({
            setTexture: (n: string) => bound.push(n),
            updateFloat4: (n: string) => updated.push(n),
            updateFloat2: (n: string) => updated.push(n),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        expect(bound).toEqual(['plainDetailTex']);
        expect(updated).toEqual([]);
    });

    it('binds the splat pair and its uniforms in splat mode', () => {
        const { mat } = make();
        const p = attachTerrainSplat(mat, tex('distr'), tex('detail'),
            [0.02, 0.02, 0.02, 0.02], [1, 1, 1, 1], 8192, 8192);
        const bound: string[] = [];
        const updated: string[] = [];
        p.bindForSubMesh({
            setTexture: (n: string) => bound.push(n),
            updateFloat4: (n: string) => updated.push(n),
            updateFloat2: (n: string) => updated.push(n),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        expect(bound).toEqual(['splatDistrTex', 'splatDetailTex']);
        expect(updated).toEqual(
            ['splatTexScales', 'splatTexMults', 'splatMapInvSize']);
    });
});
