/**
 * native-fx-renderer split test — `renderInto` draws ONLY the additive FX
 * passes into the caller's framebuffer.
 *
 * The contract the game path depends on (fx-game-loader.ts hooks it inside
 * scene.onAfterRenderingGroupObservable, where Babylon owns the target): no
 * framebuffer binds, no clears, no blits, no composite draw. `render()` — the
 * fx-viewer stage path — must still do all of those.
 *
 * GL is a recording stub: WebGL constants are ALL_CAPS properties, everything
 * else is a method, so one Proxy covers the whole surface the renderer uses.
 */

import { describe, expect, it } from 'vitest';
import {
    NativeFxRenderer, NATIVE_FX_SHADER_FILES, mat4Perspective,
    type NativeFxSources,
} from './native-fx-renderer.js';
import { MUZZLE_FLOATS, TRACER_FLOATS } from './effect-compiler.js';

interface StubGl {
    gl: WebGL2RenderingContext;
    calls: { name: string; args: unknown[] }[];
    names(): string[];
    reset(): void;
}

function stubGl(): StubGl {
    const calls: { name: string; args: unknown[] }[] = [];
    const consts = new Map<string, number>();
    const target: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
        get(_t, prop: string) {
            if (/^[A-Z0-9_]+$/.test(prop)) {
                if (!consts.has(prop)) consts.set(prop, consts.size + 1);
                return consts.get(prop);
            }
            return (...args: unknown[]) => {
                calls.push({ name: prop, args });
                switch (prop) {
                    // Link/compile always succeed; zero active uniforms keeps
                    // the location cache empty (uniform* are no-op stubs).
                    case 'getProgramParameter':
                    case 'getShaderParameter': return 1;
                    case 'getActiveUniform': return null;
                    case 'getExtension': return null;   // no float targets
                    default: return {};
                }
            };
        },
    };
    const gl = new Proxy(target, handler) as unknown as WebGL2RenderingContext;
    return {
        gl, calls,
        names: () => calls.map((c) => c.name),
        reset: () => { calls.length = 0; },
    };
}

function makeRenderer(s: StubGl): NativeFxRenderer {
    const sources: NativeFxSources = {};
    for (const f of NATIVE_FX_SHADER_FILES) sources[f] = `// ${f}`;
    return new NativeFxRenderer(s.gl, sources, {
        atlas: {} as WebGLTexture, atlasCols: 8, atlasRows: 8,
        trailStrips: { smoketrail: {} as WebGLTexture },
    });
}

const PARAMS = {
    camPos: [0, 100, 0] as [number, number, number],
    nearFar: [1, 5000] as [number, number],
    screen: [1280, 720] as [number, number],
    softRange: 0,
};

describe('NativeFxRenderer.renderInto', () => {
    it('touches no framebuffer, clears nothing, and runs no composite', () => {
        const s = stubGl();
        const r = makeRenderer(s);
        r.spawnMuzzles(new Float32Array(MUZZLE_FLOATS), 1);
        s.reset();

        r.renderInto(s.gl, new Float32Array(16), 1.0, null, PARAMS);

        const names = s.names();
        expect(names).not.toContain('bindFramebuffer');
        expect(names).not.toContain('clear');
        expect(names).not.toContain('clearColor');
        expect(names).not.toContain('blitFramebuffer');
        // The composite is the only drawArrays in the renderer; the FX passes
        // are all drawElementsInstanced.
        expect(names).not.toContain('drawArrays');
        expect(names).toContain('drawElementsInstanced');
    });

    it('sets the documented additive / depth-test-on / depth-write-off state', () => {
        const s = stubGl();
        const r = makeRenderer(s);
        s.reset();
        r.renderInto(s.gl, new Float32Array(16), 1.0, null, PARAMS);

        const blend = s.calls.find((c) => c.name === 'blendFunc');
        expect(blend?.args).toEqual([s.gl.ONE, s.gl.ONE]);
        expect(s.calls.some((c) => c.name === 'enable' && c.args[0] === s.gl.BLEND)).toBe(true);
        expect(s.calls.some((c) => c.name === 'enable' && c.args[0] === s.gl.DEPTH_TEST)).toBe(true);
        expect(s.calls.find((c) => c.name === 'depthMask')?.args).toEqual([false]);
    });

    it('refuses a foreign GL context', () => {
        const s = stubGl();
        const r = makeRenderer(s);
        expect(() => r.renderInto(stubGl().gl, new Float32Array(16), 1, null, PARAMS))
            .toThrow(/foreign GL context/);
    });

    it('render() still owns the scene FBO, the depth copy and the composite', () => {
        const s = stubGl();
        const r = makeRenderer(s);
        r.resize(1280, 720);
        s.reset();
        r.render({
            view: new Float32Array(16),
            proj: mat4Perspective(1, 16 / 9, 1, 5000),
            camPos: [0, 100, 0],
            now: 1,
            nearFar: [1, 5000],
            drawOpaque: () => {},
        });
        const names = s.names();
        expect(names).toContain('bindFramebuffer');
        expect(names).toContain('clear');
        expect(names).toContain('blitFramebuffer');
        expect(names).toContain('drawArrays');   // the composite triangle
    });
});

describe('NativeFxRenderer pool capacities (gfx.particleQuality, L-FX step 5)', () => {
    it('sizes a pool\'s GPU buffer from the capacities override, not the POOL default', () => {
        const s = stubGl();
        const sources: NativeFxSources = {};
        for (const f of NATIVE_FX_SHADER_FILES) sources[f] = `// ${f}`;
        new NativeFxRenderer(s.gl, sources, {
            atlas: {} as WebGLTexture, atlasCols: 8, atlasRows: 8,
            trailStrips: { smoketrail: {} as WebGLTexture },
        }, { tracer: 2 });

        const sizes = s.calls
            .filter((c) => c.name === 'bufferData' && c.args[0] === s.gl.ARRAY_BUFFER)
            .map((c) => c.args[1]);
        expect(sizes).toContain(2 * TRACER_FLOATS * 4);
        // The default 256-row tracer pool must NOT have been allocated.
        expect(sizes).not.toContain(256 * TRACER_FLOATS * 4);
    });

    it('an unnamed pool keeps its POOL default', () => {
        const s = stubGl();
        const r = makeRenderer(s);   // no capacities override
        s.reset();
        r.spawnMuzzles(new Float32Array(MUZZLE_FLOATS), 1);
        // Default capacity (128) never throws on a first-row spawn.
        expect(() => r.spawnMuzzles(new Float32Array(MUZZLE_FLOATS), 1)).not.toThrow();
    });
});
