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

    it('rewrites textureCube/texture3D for legacy fragment sources', () => {
        // ZK's UnitCloaker FS uses `textureCube(samplerCube, vec3)` —
        // reserved in GLSL ES 300 and must be folded into the unified
        // `texture()` overload. texture3D gets the same treatment.
        const src = `#version 120
uniform samplerCube envMap;
uniform sampler3D volume;
uniform sampler2D tex;
varying vec3 vDir;
varying vec3 vP;
varying vec2 vUv;
void main() {
    vec4 a = textureCube(envMap, vDir);
    vec4 b = texture3D(volume, vP);
    vec4 c = texture2D(tex, vUv);
    gl_FragColor = a + b + c;
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).not.toMatch(/\btextureCube\b/);
        expect(out.source).not.toMatch(/\btexture3D\b/);
        expect(out.source).not.toMatch(/\btexture2D\b/);
        expect(out.source).toContain('texture(envMap, vDir)');
        expect(out.source).toContain('texture(volume, vP)');
        expect(out.source).toContain('texture(tex, vUv)');
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

    it('does NOT promote int literals inside array subscripts (ShieldSphereColorHQ)', () => {
        // ZK's ShieldSphereColorHQ FS indexes a flat float array as
        // `hitPoints[5 * hitPointIdx + 0]`. The expression inside the
        // brackets must remain integer; promoting `5` or `0` to `5.0` /
        // `0.0` would produce `'integer expression required'` at compile.
        const src = `#version 150
uniform float hitPoints[5 * 8];
void main() {
    int hitPointIdx = 2;
    float a = hitPoints[5 * hitPointIdx + 0];
    float b = hitPoints[5 * hitPointIdx + 3];
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        // Subscript expressions stay integer.
        expect(out.source).toContain('hitPoints[5 * hitPointIdx + 0]');
        expect(out.source).toContain('hitPoints[5 * hitPointIdx + 3]');
        // Array size declaration also stays integer.
        expect(out.source).toContain('uniform float hitPoints[5 * 8]');
        // Defence against regression: nothing inside `[...]` should
        // carry `.0`.
        expect(out.source).not.toMatch(/hitPoints\[[^\]]*\.\d+/);
    });

    it('still promotes int literals OUTSIDE array subscripts even on the same line', () => {
        // The bracket-skip must not poison promotion elsewhere on the
        // same line. Construct a line where one literal is inside `[]`
        // and another is in float context — only the latter gets `.0`.
        const src = `#version 150
uniform float PI;
uniform float buf[8];
out vec4 fragColor;
void main() {
    int i = 1;
    float x = buf[2 * i] + 2 * PI;
    fragColor = vec4(x);
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        // Inside [...] stays integer.
        expect(out.source).toContain('buf[2 * i]');
        // Outside, `2 * PI` promotes to `2.0 * PI`.
        expect(out.source).toContain('2.0 * PI');
    });

    it('rewrites file-scope non-const initializers to #define (ShockWave)', () => {
        // ShockWave / SphereDistortion FS define `float p1 =
        // gl_ProjectionMatrix[2][2]` at file scope. After the legacy
        // shim renames it, the initializer references a uniform — not
        // a constant — so GLSL ES 300 rejects the global. Rewrite
        // such declarations to `#define NAME (EXPR)`.
        const src = `#version 150 compatibility
varying float life;
float p1 = gl_ProjectionMatrix[2][2];
float p2 = gl_ProjectionMatrix[2][3];
void main() {
    float z = p1 + p2 * life;
    gl_FragColor = vec4(z);
}`;
        const out = translateGLSL(src, 'fragment', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // p1 / p2 converted to macros.
        expect(out.source).toMatch(/#define p1 \([^)]*_legProjectionMatrix\[2\]\[2\]\)/);
        expect(out.source).toMatch(/#define p2 \([^)]*_legProjectionMatrix\[2\]\[3\]\)/);
        // Original file-scope declarations gone.
        expect(out.source).not.toMatch(/^\s*float\s+p1\s*=/m);
        expect(out.source).not.toMatch(/^\s*float\s+p2\s*=/m);
        // Use sites remain — they'll macro-expand at compile time.
        expect(out.source).toMatch(/float\s+z\s*=\s*p1\s*\+\s*p2/);
    });

    it('leaves file-scope const declarations alone', () => {
        // `const float PI = 3.14159;` is a real constant — must NOT
        // get rewritten to a macro (loses the type) and must keep its
        // const qualifier.
        const src = `#version 150
const float PI = 3.14159;
out vec4 fragColor;
void main() { fragColor = vec4(PI); }`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).toContain('const float PI = 3.14159;');
        expect(out.source).not.toMatch(/#define PI/);
    });

    it('leaves file-scope literal-only initializers alone', () => {
        // `float k = 5.0;` is fine at global scope (literal is
        // constant). Don't macro-rewrite it — keep the declaration.
        const src = `#version 150
float k = 5.0;
out vec4 fragColor;
void main() { fragColor = vec4(k); }`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).toMatch(/^\s*float\s+k\s*=\s*5\.0\s*;/m);
        expect(out.source).not.toMatch(/#define k/);
    });

    it('promotes int literal compared against a float intrinsic result', () => {
        // ZK ShieldSphereColorHQ FS:
        //     if (length(offset2) > 0) { ... }
        // GLSL ES 300 strict rejects `float > int`. Rule 4b' must catch
        // length() / distance() / dot() / etc. on the LHS and append
        // `.0` to the integer RHS.
        const src = `#version 150
out vec4 fragColor;
in vec2 offset2;
in float val;
void main() {
    if (length(offset2) > 0) fragColor = vec4(1);
    if (distance(offset2, vec2(0)) < 1) fragColor = vec4(0);
    if (dot(offset2, offset2) >= 0) fragColor.r = 1.0;
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        // Be lenient about the call-body: distance() carries a nested
        // `vec2(0)`, so a `[^)]*` match can't span it. Just confirm the
        // intrinsic name + comparison-with-promoted-literal pair.
        expect(out.source).toContain('length(offset2) > 0.0');
        expect(out.source).toContain('distance(offset2, vec2(0)) < 1.0');
        expect(out.source).toContain('dot(offset2, offset2) >= 0.0');
    });

    it('does NOT promote literal compared against user-function call', () => {
        // The intrinsic whitelist limits the rule to known
        // float-returning functions. A user-defined function that
        // returns int must NOT have its comparison RHS promoted.
        const src = `#version 150
int countItems() { return 0; }
out vec4 fragColor;
void main() {
    if (countItems() > 0) fragColor = vec4(1);
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        // The 0 must stay an int — `countItems() > 0`.
        expect(out.source).toMatch(/countItems\(\)\s*>\s*0(?!\.)/);
    });

    it('does not rewrite identical-named declarations inside function scope', () => {
        // A local `float p1 = ...` inside main() is a normal
        // declaration — it must stay a declaration.
        const src = `#version 150
out vec4 fragColor;
uniform float u;
void main() {
    float p1 = u * 2.0;
    fragColor = vec4(p1);
}`;
        const out = translateGLSL(src, 'fragment');
        expect(out.ok).toBe(true);
        expect(out.source).toMatch(/float\s+p1\s*=\s*u\s*\*\s*2\.0\s*;/);
        expect(out.source).not.toMatch(/#define p1/);
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
        expect(out.source).toContain('_legFrontColor');
        expect(out.source).not.toMatch(/\bgl_Vertex\b/);
        expect(out.source).not.toMatch(/\bgl_ModelViewMatrix\b/);
        expect(out.source).not.toMatch(/\bgl_FrontColor\b/);
        // Declarations injected for renamed identifiers.
        expect(out.source).toContain('layout(location = 0) in vec4 _legVertex;');
        expect(out.source).toContain('uniform mat4 _legModelViewMatrix;');
        expect(out.source).toContain('uniform mat4 _legProjectionMatrix;');
        expect(out.source).toContain('out vec4 _legFrontColor;');
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
        // gl_Color in FS reads the varying coming from gl_FrontColor in
        // VS — both end up as the single `_legFrontColor` identifier.
        expect(out.source).toContain('_legFrontColor');
        expect(out.source).toContain('in vec4 _legFrontColor;');
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
        // Body references must be renamed, not just declarations
        // (regression: ZK LUPS NanoLasers had `#define endpos
        // gl_MultiTexCoord1` and the rename loop was missing, leaving
        // the unrenamed identifier to fail GLSL ES 300 compile).
        expect(out.source).not.toMatch(/\bgl_MultiTexCoord\d\b/);
    });

    it('renames gl_MultiTexCoord* inside #define bodies (NanoLasers regression)', () => {
        const src = `#version 150 compatibility
#define startpos gl_MultiTexCoord0
#define endpos   gl_MultiTexCoord1
void main() {
    gl_Position = gl_ModelViewMatrix * (endpos - startpos);
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('#define startpos _legMultiTexCoord0');
        expect(out.source).toContain('#define endpos   _legMultiTexCoord1');
        expect(out.source).not.toMatch(/\bgl_MultiTexCoord\d\b/);
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

    it('keeps gl_Color (VS input) and gl_FrontColor (VS varying) as distinct identifiers', () => {
        // ZK NanoLasers/Ribbon/RingParticles VSs all do this:
        // read the per-vertex colour input AND write to the varying.
        // Both must compile without redefinition or l-value errors.
        const src = `#version 150 compatibility
void main() {
    gl_FrontColor = gl_Color;
    gl_FrontColor.rgb *= 2.0;
    gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // Two distinct declarations — input attribute and varying out.
        expect(out.source).toContain('layout(location = 1) in vec4 _legColor;');
        expect(out.source).toContain('out vec4 _legFrontColor;');
        // No collapsed identifier (the original bug).
        expect(out.source).not.toMatch(/in vec4 _legColor;\s*\n[^\n]*out vec4 _legColor;/);
        // Assignment target is the varying, source is the attribute.
        expect(out.source).toMatch(/_legFrontColor\s*=\s*_legColor/);
    });

    it('shims gl_FrontSecondaryColor + gl_SecondaryColor as a second varying', () => {
        const vs = `#version 150 compatibility
void main() {
    gl_FrontSecondaryColor = vec4(0.5);
    gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
}`;
        const vsOut = translateGLSL(vs, 'vertex', { legacyGL2Shim: true });
        expect(vsOut.ok).toBe(true);
        expect(vsOut.source).toContain('out vec4 _legFrontSecondaryColor;');
        expect(vsOut.source).not.toMatch(/\bgl_FrontSecondaryColor\b/);

        const fs = `#version 150 compatibility
void main() {
    gl_FragColor = gl_SecondaryColor;
}`;
        const fsOut = translateGLSL(fs, 'fragment', { legacyGL2Shim: true });
        expect(fsOut.ok).toBe(true);
        expect(fsOut.source).toContain('in vec4 _legFrontSecondaryColor;');
        expect(fsOut.source).not.toMatch(/\bgl_SecondaryColor\b/);
    });

    it('shims gl_TextureMatrix[] as a uniform array (UnitSmoke)', () => {
        const src = `#version 150 compatibility
void main() {
    gl_TexCoord[0] = gl_TextureMatrix[0] * gl_MultiTexCoord0;
    gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex;
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        expect(out.source).toContain('uniform mat4 _legTextureMatrix[8];');
        expect(out.source).toContain('_legTextureMatrix[0]');
        expect(out.source).not.toMatch(/\bgl_TextureMatrix\b/);
    });

    it('shims ftransform() and gl_LightSource (UnitCloaker)', () => {
        const src = `#version 150 compatibility
void main() {
    gl_FrontColor.rgb = gl_LightSource[0].diffuse.rgb + gl_LightSource[0].ambient.rgb;
    gl_Position = ftransform();
}`;
        const out = translateGLSL(src, 'vertex', { legacyGL2Shim: true });
        expect(out.ok).toBe(true);
        // ftransform() replaced with explicit MVP × vertex multiply.
        expect(out.source).toMatch(/_legModelViewProjectionMatrix\s*\*\s*_legVertex/);
        expect(out.source).not.toMatch(/\bftransform\b/);
        // gl_LightSource → struct uniform.
        expect(out.source).toContain('struct _legLightSourceParameters');
        expect(out.source).toContain('uniform _legLightSourceParameters _legLightSource[8];');
        expect(out.source).not.toMatch(/\bgl_LightSource\b/);
        // ftransform() should pull in _legVertex + MVP even though the
        // source didn't reference them by name.
        expect(out.source).toContain('layout(location = 0) in vec4 _legVertex;');
        expect(out.source).toContain('uniform mat4 _legModelViewProjectionMatrix;');
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
