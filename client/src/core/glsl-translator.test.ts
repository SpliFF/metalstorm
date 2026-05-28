import { describe, it, expect } from 'vitest';
import {
    translateGLSL,
    resolveIncludes,
    translateAndInclude,
    hashSource,
    ENGINE_SNIPPETS,
} from './glsl-translator';

describe('translateGLSL', () => {
    it('injects ES 300 header and strips desktop #version', () => {
        const out = translateGLSL('#version 150 compatibility\nvoid main(){}', 'vertex');
        expect(out.ok).toBe(true);
        expect(out.source.startsWith('#version 300 es\n')).toBe(true);
        // Original directive must not survive — `#version` appears once.
        expect(out.source.match(/#version/g)!.length).toBe(1);
        expect(out.source).toContain('precision highp float;');
    });

    it('strips #extension directives so they cannot stray past header', () => {
        const out = translateGLSL(
            '#version 150 compatibility\n#extension GL_ARB_explicit_attrib_location : enable\nvoid main(){}',
            'vertex',
        );
        expect(out.ok).toBe(true);
        expect(out.source).not.toContain('#extension');
    });

    it('rewrites legacy fragment qualifiers and gl_FragColor', () => {
        const src = `#version 120
varying vec2 vUv;
uniform sampler2D tex;
void main() { gl_FragColor = texture2D(tex, vUv); }`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).toContain('in vec2 vUv;');
        expect(out.source).toContain('out vec4 outFragColor;');
        expect(out.source).toContain('outFragColor = texture(tex, vUv);');
        expect(out.source).not.toContain('gl_FragColor');
        expect(out.source).not.toContain('varying');
        expect(out.source).not.toContain('texture2D');
    });

    it('rewrites vertex attribute/varying for legacy sources', () => {
        const src = `#version 120
attribute vec3 aPos;
varying vec3 vColor;
void main() { gl_Position = vec4(aPos, 1.0); vColor = aPos; }`;
        const out = translateGLSL(src, 'vertex');
        expect(out.ok).toBe(true);
        expect(out.source).toContain('in vec3 aPos;');
        expect(out.source).toContain('out vec3 vColor;');
        expect(out.source).not.toContain('attribute');
        expect(out.source).not.toContain('varying');
    });

    it('promotes bare int literals to floats in arithmetic context', () => {
        // `2*PI` would fail under ES 300 strict — should become `2.0*PI`.
        const src = `#version 150
uniform float PI;
out vec4 fragColor;
void main() { fragColor = vec4(2*PI); }`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).toContain('2.0*PI');
    });

    it('rejects #version 420 with an info diagnostic and expected flag', () => {
        const src = `#version 420
layout(binding=0) buffer Data { vec4 v[]; };
void main(){}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(false);
        expect(out.expectedReject).toBe(true);
        expect(out.source).toContain('#error');
        expect(out.diagnostics.length).toBeGreaterThan(0);
        expect(out.diagnostics[0].severity).toBe('info');
    });

    it('rejects legacy gl_Vertex as expected (fallback path)', () => {
        const src = `#version 150 compatibility
void main() { gl_Position = gl_Vertex; }`;
        const out = translateGLSL(src, 'vertex');
        expect(out.ok).toBe(false);
        expect(out.expectedReject).toBe(true);
        expect(out.diagnostics[0].message).toContain('gl_Vertex');
        expect(out.diagnostics[0].line).toBe(2);
    });

    it('keeps gl_Vertex-only sources on the reject path even with shim enabled', () => {
        // Chili `gui_chili_minimap`'s fadeShader has no fixed-function
        // matrices — it must keep falling back so the widget skips its
        // shader path, since the immediate-mode renderer's flush() still
        // overrides the bound program.
        const src = `#version 150 compatibility
varying vec2 texCoord;
void main() {
    texCoord = gl_Vertex.xy * 0.5 + 0.5;
    gl_Position = vec4(gl_Vertex.xyz, 1.0);
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(false);
        expect(out.expectedReject).toBe(true);
    });

    it('loudly rejects imageLoad with source line', () => {
        const src = `#version 310 es
layout(rgba32f, binding=0) uniform image2D tex;
void main() { vec4 c = imageLoad(tex, ivec2(0,0)); }`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(false);
        expect(out.expectedReject).toBe(false);
        const err = out.diagnostics.find(d => d.severity === 'error');
        expect(err).toBeDefined();
        expect(err!.message).toContain('imageLoad');
        expect(err!.line).toBe(3);
    });

    it('loudly rejects samplerCubeArray', () => {
        const src = `#version 150
uniform samplerCubeArray probeCubes;
void main(){}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(false);
        const err = out.diagnostics.find(d => d.severity === 'error');
        expect(err!.message).toContain('samplerCubeArray');
    });

    it('loudly rejects SSBO declarations', () => {
        const src = `#version 310 es
layout(std430, binding=0) buffer UnitData { vec4 data[]; };
void main(){}`;
        const out = translateGLSL(src, 'vertex');
        expect(out.ok).toBe(false);
        const err = out.diagnostics.find(d => d.severity === 'error');
        expect(err!.message).toContain('SSBO');
    });

    it('casts gl_InstanceID when used in float arithmetic', () => {
        const src = `#version 150
void main() { float t = 0.5 * gl_InstanceID; }`;
        const out = translateGLSL(src, 'vertex');
        expect(out.ok).toBe(true);
        expect(out.source).toContain('float(gl_InstanceID)');
    });
});

describe('translateGLSL — legacy GL2 fixed-function shim', () => {
    it('shims LUPS-style vertex shaders with matrices and varyings', () => {
        // Trimmed from content/games/zk/lups/ParticleClasses/SimpleParticles2.lua.
        const src = `#version 150 compatibility
varying vec2 texCoord;
void main() {
    vec4 pos4 = gl_Vertex;
    gl_Position = gl_ModelViewMatrix * pos4;
    gl_Position = gl_ProjectionMatrix * gl_Position;
    gl_FrontColor = vec4(1.0);
    texCoord = gl_Vertex.xy;
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source.startsWith('#version 300 es\n')).toBe(true);
        // gl_* renames into _leg* identifiers.
        expect(out.source).toContain('_legVertex');
        expect(out.source).toContain('_legModelViewMatrix');
        expect(out.source).toContain('_legProjectionMatrix');
        expect(out.source).toContain('_legColor');
        expect(out.source).not.toMatch(/\bgl_Vertex\b/);
        expect(out.source).not.toMatch(/\bgl_ModelViewMatrix\b/);
        expect(out.source).not.toMatch(/\bgl_FrontColor\b/);
        // Declarations injected for renamed identifiers.
        expect(out.source).toContain('layout(location = 0) in vec4 _legVertex;');
        expect(out.source).toContain('uniform mat4 _legModelViewMatrix;');
        expect(out.source).toContain('uniform mat4 _legProjectionMatrix;');
        expect(out.source).toContain('out vec4 _legColor;');
        // gl_Position stays — it's a real ES 300 builtin.
        expect(out.source).toContain('gl_Position');
    });

    it('shims fragment side: gl_Color and gl_FragColor', () => {
        const src = `#version 150 compatibility
uniform sampler2D tex0;
varying vec2 texCoord;
void main() {
    gl_FragColor = texture2D(tex0, texCoord) * gl_Color;
}`;
        const out = translateGLSL(src, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // gl_Color → _legColor (in fragment, this is the varying coming
        // from gl_FrontColor in vertex).
        expect(out.source).toContain('_legColor');
        expect(out.source).toContain('in vec4 _legColor;');
        expect(out.source).not.toMatch(/\bgl_Color\b/);
        // gl_FragColor handled by the existing legacy block.
        expect(out.source).toContain('outFragColor');
        expect(out.source).toContain('out vec4 outFragColor;');
        expect(out.source).not.toContain('gl_FragColor');
    });

    it('declares gl_TexCoord array as a varying when used', () => {
        const src = `#version 150 compatibility
void main() {
    gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
    gl_TexCoord[0] = vec4(gl_Vertex.xy, 0.0, 1.0);
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('_legTexCoord[0]');
        expect(out.source).toContain('out vec4 _legTexCoord[8];');
        expect(out.source).toContain('uniform mat4 _legModelViewProjectionMatrix;');
    });

    it('declares gl_MultiTexCoord0..3 only for slots that appear in source', () => {
        const src = `#version 150 compatibility
void main() {
    vec4 a = gl_MultiTexCoord0;
    vec4 b = gl_MultiTexCoord2;
    gl_Position = gl_ModelViewMatrix * gl_Vertex;
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('_legMultiTexCoord0');
        expect(out.source).toContain('_legMultiTexCoord2');
        expect(out.source).not.toContain('_legMultiTexCoord1');
        expect(out.source).not.toContain('_legMultiTexCoord3');
        // Slot 0 keeps location 2 (matches immediate-mode texcoord
        // stream); higher slots get linker-assigned locations.
        expect(out.source).toContain('layout(location = 2) in vec4 _legMultiTexCoord0;');
    });

    it('does not declare unused builtins', () => {
        const src = `#version 150 compatibility
void main() {
    gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).not.toContain('_legNormal');
        expect(out.source).not.toContain('_legTexCoord');
        expect(out.source).not.toContain('_legColor');
        expect(out.source).not.toContain('_legProjectionMatrix');
        expect(out.source).not.toContain('_legModelViewMatrix ');
    });

    it('can be explicitly disabled to force the reject path', () => {
        // LUPS-style source with matrices, but caller opts out of the
        // shim entirely — translator must take the reject path.
        const src = `#version 150 compatibility
void main() { gl_Position = gl_ModelViewMatrix * gl_Vertex; }`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: false });
        expect(out.ok).toBe(false);
        expect(out.expectedReject).toBe(true);
    });

    it('translateAndInclude propagates the shim option', () => {
        const src = `#version 150
void main() { gl_Position = gl_ModelViewMatrix * gl_Vertex; }`;
        const out = translateAndInclude(src, 'vertex', {
            lookup: () => undefined,
            legacyGL2Shim: true,
        });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('_legModelViewMatrix');
        expect(out.source).toContain('_legVertex');
    });
});

describe('resolveIncludes', () => {
    it('expands a built-in snippet (engine/csm.glsl)', () => {
        const src = `#version 300 es\n#include "engine/csm.glsl"\nvoid main(){}`;
        const out = resolveIncludes(src, { lookup: () => undefined });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('sampleCsmShadow(vec3 worldPos');
        expect(out.included).toContain('engine/csm.glsl');
        // Bracketing markers so error reporting can locate the include.
        expect(out.source).toContain('// >>> engine/csm.glsl');
        expect(out.source).toContain('// <<< engine/csm.glsl');
    });

    it('expands VFS includes ahead of the input source', () => {
        const files: Record<string, string> = {
            'inc/util.glsl': 'float scale(float x){ return x * 2.0; }\n',
        };
        const src = `#include "inc/util.glsl"\nvoid main() { float y = scale(1.0); }`;
        const out = resolveIncludes(src, { lookup: (p) => files[p] });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('float scale(float x)');
        expect(out.included).toEqual(['inc/util.glsl']);
    });

    it('reports an error when the include is missing', () => {
        const src = `#include "nope.glsl"\nvoid main(){}`;
        const out = resolveIncludes(src, { lookup: () => undefined });
        expect(out.ok).toBe(false);
        expect(out.diagnostics[0].message).toContain('not found');
        expect(out.source).toContain('#error');
    });

    it('detects self-include cycles', () => {
        const files: Record<string, string> = {
            'a.glsl': '#include "a.glsl"\n',
        };
        const src = '#include "a.glsl"\n';
        const out = resolveIncludes(src, { lookup: (p) => files[p] });
        expect(out.ok).toBe(false);
        const err = out.diagnostics.find(d => d.message.includes('cycle'));
        expect(err).toBeDefined();
    });

    it('honours #include line numbers in diagnostics', () => {
        const src = `// pad\n// pad\n#include "missing.glsl"\nvoid main(){}`;
        const out = resolveIncludes(src, { lookup: () => undefined });
        expect(out.diagnostics[0].line).toBe(3);
    });
});

describe('translateAndInclude', () => {
    it('expands then translates in one call', () => {
        const src = `#version 150
#include "engine/csm.glsl"
out vec4 fragColor;
in vec3 vWorldPos;
in float vViewZ;
void main() {
    float s = sampleCsmShadow(vWorldPos, vViewZ);
    fragColor = vec4(vec3(s), 1.0);
}`;
        const out = translateAndInclude(src, 'fragment', { lookup: () => undefined });
        expect(out.ok).toBe(true);
        expect(out.source.startsWith('#version 300 es\n')).toBe(true);
        expect(out.source).toContain('sampler2DArray csmShadowMap');
        expect(out.included).toEqual(['engine/csm.glsl']);
    });

    it('short-circuits translation when include fails', () => {
        const out = translateAndInclude(
            '#include "missing.glsl"\nvoid main(){}',
            'fragment',
            { lookup: () => undefined },
        );
        expect(out.ok).toBe(false);
        expect(out.diagnostics.some(d => d.message.includes('not found'))).toBe(true);
    });
});

describe('hashSource', () => {
    it('is stable across calls and 16 hex chars', () => {
        const h1 = hashSource('hello');
        const h2 = hashSource('hello');
        expect(h1).toBe(h2);
        expect(h1.length).toBe(16);
        expect(/^[0-9a-f]{16}$/.test(h1)).toBe(true);
    });

    it('distinguishes near-identical inputs', () => {
        expect(hashSource('void main(){}')).not.toBe(hashSource('void main(){ }'));
    });
});

describe('ENGINE_SNIPPETS', () => {
    it('exposes engine/csm.glsl and the legacy alias', () => {
        expect(ENGINE_SNIPPETS['engine/csm.glsl']).toContain('sampleCsmShadow');
        expect(ENGINE_SNIPPETS['ShadowFragSnippet.glsl']).toBe(ENGINE_SNIPPETS['engine/csm.glsl']);
    });
});
