import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, StandardMaterial } from '@babylonjs/core';
import type { BaseTexture } from '@babylonjs/core';
import {
    TerrainSplatPlugin, attachTerrainSplat, attachTerrainDetailPlain,
    attachTerrainSplatNormal, SMF_DETAILTEX_RES,
} from './terrain-splat-plugin.js';

// The shading itself needs a real GL context to observe; what is asserted here
// is the wiring a live run then depends on — that the three branches of
// Recoil's SMF detail shading (splat-normal / splat / plain,
// PLAN-terrain-detailtex.md §2.1) are selected by mutually exclusive defines,
// that each declares the sampler its shader branch reads, and that the attach
// helpers pick the intended mode. The mutual exclusivity is the invariant
// worth a test: a material carrying both would double-add signed detail and
// brighten the ground.

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
        const d = {
            TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
            TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false,
        };
        plugin.prepareDefines(d);
        return d;
    };

    it('defaults to splat mode and to disabled', () => {
        const { plugin } = make();
        expect(plugin.mode).toBe('splat');
        expect(plugin.isEnabled).toBe(false);
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
    });

    it('enables exactly one define per mode, never both', () => {
        const { plugin } = make();
        plugin.isEnabled = true;
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: true, TERRAIN_DETAIL_PLAIN: false,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
        plugin.mode = 'plain';
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: true,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
    });

    it('drops both defines when disabled in either mode', () => {
        const { plugin } = make();
        plugin.mode = 'plain';
        plugin.isEnabled = true;
        plugin.isEnabled = false;
        expect(defines(plugin)).toEqual(
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
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
            { TERRAIN_SPLAT: true, TERRAIN_DETAIL_PLAIN: false,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
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
            { TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: true,
              TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false });
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

    // --- SMF_DETAIL_NORMAL_TEXTURE_SPLATTING (endtoend D48) -------------

    const normals = (): BaseTexture[] =>
        [tex('n0'), tex('n1'), tex('n2'), tex('n3')];

    it('attachTerrainSplatNormal configures splatNormal mode', () => {
        const { mat } = make();
        const p = attachTerrainSplatNormal(
            mat, tex('distr'), normals(),
            [0.018, 0.005, 0.02, 0.02], [1, 1, 1, 1], true, 7168, 7168);
        expect(p.mode).toBe('splatNormal');
        expect(p.isEnabled).toBe(true);
        expect(p.diffuseAlpha).toBe(true);
        expect(p.normalTextures).toHaveLength(4);
        // The splatDetailTex is the texture this branch must NOT sample —
        // on scorched_crossing its alpha is a constant 1.0, which is what
        // whitewashed the map (D48).
        expect(p.detailTexture).toBeNull();
        expect(p.plainDetailTexture).toBeNull();
    });

    it('selects splatNormal exclusively, and gates diffuse alpha on the flag', () => {
        const { mat } = make();
        const p = attachTerrainSplatNormal(
            mat, tex('distr'), normals(),
            [0.02, 0.02, 0.02, 0.02], [1, 1, 1, 1], true, 1024, 1024);
        expect(defines(p)).toEqual({
            TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
            TERRAIN_SPLAT_NORMAL: true, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: true,
        });
        // diffuseAlpha clear = Recoil contributes NO albedo detail from this
        // branch (splatDetailStrength.y stays 0), only a perturbed normal.
        p.diffuseAlpha = false;
        expect(defines(p)).toEqual({
            TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
            TERRAIN_SPLAT_NORMAL: true, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false,
        });
        // ...and the alpha define can never outlive its own branch.
        p.isEnabled = false;
        p.diffuseAlpha = true;
        expect(defines(p)).toEqual({
            TERRAIN_SPLAT: false, TERRAIN_DETAIL_PLAIN: false,
            TERRAIN_SPLAT_NORMAL: false, TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA: false,
        });
    });

    it('declares and binds the four detail-normal samplers, not splatDetailTex', () => {
        const samplers: string[] = [];
        make().plugin.getSamplers(samplers);
        for (let i = 0; i < 4; i++) expect(samplers).toContain(`splatNormalTex${i}`);

        const { mat } = make();
        const p = attachTerrainSplatNormal(mat, tex('distr'), normals(),
            [0.02, 0.02, 0.02, 0.02], [1, 1, 1, 1], true, 1024, 1024);
        // A stale splatDetailTex left on the plugin must still not be bound.
        p.detailTexture = tex('detail');
        const bound: string[] = [];
        const updated: string[] = [];
        p.bindForSubMesh({
            setTexture: (n: string) => bound.push(n),
            updateFloat4: (n: string) => updated.push(n),
            updateFloat2: (n: string) => updated.push(n),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        expect(bound).toEqual(['splatDistrTex', 'splatNormalTex0',
            'splatNormalTex1', 'splatNormalTex2', 'splatNormalTex3']);
        expect(bound).not.toContain('splatDetailTex');
        expect(updated).toEqual(
            ['splatTexScales', 'splatTexMults', 'splatMapInvSize']);
    });

    it('reproduces GetSplatDetailTextureNormal in the fragment branch', () => {
        const code = make().plugin.getCustomCode('fragment');
        const defs = code!.CUSTOM_FRAGMENT_DEFINITIONS;
        const body = code!.CUSTOM_FRAGMENT_BEFORE_LIGHTS;
        expect(defs).toContain('#ifdef TERRAIN_SPLAT_NORMAL');
        expect(defs).toContain('uniform sampler2D splatNormalTex0;');
        expect(body).toContain('#ifdef TERRAIN_SPLAT_NORMAL');
        // The blend weights are the same cofac the splat branch uses...
        expect(body).toContain(
            'texture(splatDistrTex, _snWorld * splatMapInvSize) * splatTexMults');
        // ...the mix strength is Recoil's saturated weight sum...
        expect(body).toContain('min(1.0, dot(_snCofac, vec4(1.0)))');
        // ...the up-bias guard for all-zero weights is kept...
        expect(body).toContain('_snN.y = max(_snN.y, 0.01);');
        // ...the albedo detail is the CLAMPED alpha, behind its own define...
        expect(body).toContain('#ifdef TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA');
        expect(body).toContain('baseColor.rgb += vec3(clamp(_snN.a, -1.0, 1.0));');
        // ...and the perturbed normal actually reaches the light loop.
        expect(body).toContain('normalW = normalize(mix(normalW,');
    });

    it('never lets the splat-normal and splat branches sample together', () => {
        const { mat } = make();
        const p = attachTerrainSplatNormal(mat, tex('distr'), normals(),
            [0.02, 0.02, 0.02, 0.02], [1, 1, 1, 1], true, 1024, 1024);
        const d = defines(p);
        const on = Object.entries(d)
            .filter(([k, v]) => v && k !== 'TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA')
            .map(([k]) => k);
        expect(on).toEqual(['TERRAIN_SPLAT_NORMAL']);
    });
});
