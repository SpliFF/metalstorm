import { describe, it, expect, beforeEach } from 'vitest';
import { ImmediateModeRenderer } from './lua-gl-immediate.js';

// ── Minimal call-counting WebGL2 mock ───────────────────────────────────
// The ImmediateModeRenderer only needs a handful of GL entry points: shader/
// program creation (constructor), and the per-flush state + draw calls. This
// mock stubs them and counts invocations so we can assert PLAN-perf N3's
// redundant-state elimination (skip no-op useProgram/bind*/uniform* between
// same-state draws) and the text/geometry batching (one drawArrays per
// gl.BeginEnd batch, regardless of quad count).

function makeMockGL(): { gl: WebGL2RenderingContext; counts: Record<string, number> } {
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
    let handle = 1;
    const obj = (): object => ({ __id: handle++ });

    // GL enum constants the renderer references (arbitrary distinct numbers).
    const K: Record<string, number> = {
        VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
        ARRAY_BUFFER: 5, DYNAMIC_DRAW: 6, FLOAT: 7, TEXTURE_2D: 8, TEXTURE0: 9,
        POINTS: 0x0000, LINES: 0x0001, LINE_LOOP: 0x0002, LINE_STRIP: 0x0003,
        TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005, TRIANGLE_FAN: 0x0006,
    };

    const gl = {
        ...K,
        createShader: () => { bump('createShader'); return obj(); },
        shaderSource: () => {},
        compileShader: () => {},
        getShaderParameter: () => true,
        getShaderInfoLog: () => '',
        deleteShader: () => {},
        createProgram: () => { bump('createProgram'); return obj(); },
        attachShader: () => {},
        linkProgram: () => {},
        getProgramParameter: () => true,
        getProgramInfoLog: () => '',
        deleteProgram: () => {},
        getUniformLocation: () => obj(),
        createVertexArray: () => { bump('createVertexArray'); return obj(); },
        createBuffer: () => { bump('createBuffer'); return obj(); },
        deleteVertexArray: () => {},
        deleteBuffer: () => {},
        bindVertexArray: () => bump('bindVertexArray'),
        bindBuffer: () => bump('bindBuffer'),
        bufferData: () => bump('bufferData'),
        bufferSubData: () => bump('bufferSubData'),
        enableVertexAttribArray: () => {},
        vertexAttribPointer: () => {},
        useProgram: () => bump('useProgram'),
        uniformMatrix4fv: () => bump('uniformMatrix4fv'),
        uniformMatrix3fv: () => bump('uniformMatrix3fv'),
        uniform1i: () => bump('uniform1i'),
        uniform1f: () => bump('uniform1f'),
        uniform4f: () => bump('uniform4f'),
        activeTexture: () => bump('activeTexture'),
        bindTexture: () => bump('bindTexture'),
        drawArrays: () => bump('drawArrays'),
        getParameter: () => 0,
    } as unknown as WebGL2RenderingContext;

    return { gl, counts };
}

describe('ImmediateModeRenderer — N3 redundant-state elimination', () => {
    let gl: WebGL2RenderingContext;
    let counts: Record<string, number>;
    let imm: ImmediateModeRenderer;

    beforeEach(() => {
        ({ gl, counts } = makeMockGL());
        imm = new ImmediateModeRenderer(gl);
        // Simulate a UI pass: a projection is set up, shadow reset.
        imm.beginPass();
        imm.matrixMode(0x1701); // GL_PROJECTION
        imm.ortho(0, 800, 600, 0, -1, 1);
        imm.matrixMode(0x1700); // GL_MODELVIEW
        imm.loadIdentity();
    });

    it('binds program / VAO / buffer once across many same-state draws', () => {
        const before = { ...counts };
        for (let i = 0; i < 8; i++) imm.rect(i, i, i + 10, i + 10);

        const d = (k: string) => (counts[k] ?? 0) - (before[k] ?? 0);
        // 8 rects → 8 draws, but the program / VAO / ARRAY_BUFFER bindings are
        // issued only once (they never change between draws in a pass).
        expect(d('drawArrays')).toBe(8);
        expect(d('bufferSubData')).toBe(8);
        expect(d('useProgram')).toBe(1);
        expect(d('bindVertexArray')).toBe(1);
        expect(d('bindBuffer')).toBe(1);
    });

    it('uploads uMVP once when the matrix is unchanged, again when it changes', () => {
        const before = { ...counts };
        imm.rect(0, 0, 10, 10);
        imm.rect(20, 0, 30, 10); // same matrix → no re-upload
        expect((counts['uniformMatrix4fv'] ?? 0) - (before['uniformMatrix4fv'] ?? 0)).toBe(1);

        imm.translate(5, 5, 0); // matrix changed
        imm.rect(0, 0, 10, 10);
        expect((counts['uniformMatrix4fv'] ?? 0) - (before['uniformMatrix4fv'] ?? 0)).toBe(2);
    });

    it('uploads uColor once when the colour is unchanged', () => {
        imm.color(1, 0, 0, 1);
        const before = { ...counts };
        imm.rect(0, 0, 10, 10);
        imm.rect(20, 0, 30, 10);
        imm.rect(40, 0, 50, 10);
        // colour constant across the three draws → one uniform4f upload.
        expect((counts['uniform4f'] ?? 0) - (before['uniform4f'] ?? 0)).toBe(1);
    });

    it('re-binds after invalidateBindings (external VAO/buffer use mid-pass)', () => {
        imm.rect(0, 0, 10, 10);
        const before = { ...counts };
        imm.invalidateBindings();
        imm.rect(20, 0, 30, 10);
        expect((counts['bindVertexArray'] ?? 0) - (before['bindVertexArray'] ?? 0)).toBe(1);
        expect((counts['bindBuffer'] ?? 0) - (before['bindBuffer'] ?? 0)).toBe(1);
        expect((counts['useProgram'] ?? 0) - (before['useProgram'] ?? 0)).toBe(1);
    });

    it('re-issues all state on the first draw of the next pass (beginPass)', () => {
        imm.rect(0, 0, 10, 10);
        imm.rect(20, 0, 30, 10);
        const before = { ...counts };
        imm.beginPass(); // new pass — Babylon rebinds everything in between
        imm.rect(0, 0, 10, 10);
        expect((counts['useProgram'] ?? 0) - (before['useProgram'] ?? 0)).toBe(1);
        expect((counts['bindVertexArray'] ?? 0) - (before['bindVertexArray'] ?? 0)).toBe(1);
        expect((counts['bindBuffer'] ?? 0) - (before['bindBuffer'] ?? 0)).toBe(1);
        expect((counts['uniformMatrix4fv'] ?? 0) - (before['uniformMatrix4fv'] ?? 0)).toBe(1);
    });
});

describe('ImmediateModeRenderer — N3 batching (gl.BeginEnd = one draw)', () => {
    it('emits a single drawArrays for a multi-quad BeginEnd batch (the text path)', () => {
        const { gl, counts } = makeMockGL();
        const imm = new ImmediateModeRenderer(gl);
        imm.beginPass();
        imm.matrixMode(0x1700);
        imm.loadIdentity();

        const before = { ...counts };
        // 20 glyph quads = 120 vertices, emitted the way renderString does now.
        imm.setTextured(true, {} as WebGLTexture);
        imm.beginEnd(gl.TRIANGLES, () => {
            for (let g = 0; g < 20; g++) {
                const x = g * 8;
                imm.texCoord(0, 0); imm.vertex(x, 0);
                imm.texCoord(1, 0); imm.vertex(x + 6, 0);
                imm.texCoord(1, 1); imm.vertex(x + 6, 10);
                imm.texCoord(0, 0); imm.vertex(x, 0);
                imm.texCoord(1, 1); imm.vertex(x + 6, 10);
                imm.texCoord(0, 1); imm.vertex(x, 10);
            }
        });
        // One batched draw for the whole string, not one per glyph.
        expect((counts['drawArrays'] ?? 0) - (before['drawArrays'] ?? 0)).toBe(1);
        expect((counts['bufferSubData'] ?? 0) - (before['bufferSubData'] ?? 0)).toBe(1);
    });
});
