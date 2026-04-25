/**
 * ImmediateModeRenderer — emulates OpenGL 1.x immediate-mode drawing on
 * WebGL2 for the Spring gl.* Lua API.
 *
 * Spring's Lua widgets draw UI via gl.BeginEnd(mode, fn) where fn calls
 * gl.Vertex/gl.Color/gl.MultiTexCoord to define vertices one at a time.
 * WebGL2 has no immediate mode, so we batch vertices into a dynamic VBO
 * and flush them as a single draw call when the BeginEnd callback returns.
 *
 * Also provides a matrix stack (modelview + projection) and convenience
 * drawing for gl.Rect/gl.TexRect.
 */

// ── Shader sources ──────────────────────────────────────────────────────

const VS_SOURCE = `#version 300 es
precision highp float;

layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec2 aTexCoord;

uniform mat4 uMVP;

out vec4 vColor;
out vec2 vTexCoord;

void main() {
    gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
    vColor = aColor;
    vTexCoord = aTexCoord;
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;

in vec4 vColor;
in vec2 vTexCoord;

uniform sampler2D uTex;
uniform int uTextured;
uniform float uAlphaThreshold;
uniform vec4 uColor;

out vec4 fragColor;

void main() {
    vec4 c;
    if (uTextured != 0) {
        c = texture(uTex, vTexCoord) * vColor * uColor;
    } else {
        c = vColor * uColor;
    }
    if (c.a < uAlphaThreshold) discard;
    fragColor = c;
}
`;

// ── Constants ───────────────────────────────────────────────────────────

/** Max vertices per BeginEnd batch. 64K is generous for UI. */
const MAX_VERTICES = 65536;

/** Floats per vertex: x, y, r, g, b, a, s, t = 8 */
const FLOATS_PER_VERTEX = 8;

/** Bytes per vertex */
const BYTES_PER_VERTEX = FLOATS_PER_VERTEX * 4;

// GL primitive modes
const GL_POINTS = 0x0000;
const GL_LINES = 0x0001;
const GL_LINE_LOOP = 0x0002;
const GL_LINE_STRIP = 0x0003;
const GL_TRIANGLES = 0x0004;
const GL_TRIANGLE_STRIP = 0x0005;
const GL_TRIANGLE_FAN = 0x0006;
const GL_QUADS = 0x0007;

// ── Matrix helpers (column-major Float32Array[16]) ──────────────────────

function mat4Identity(): Float32Array {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
}

function mat4Copy(src: Float32Array): Float32Array {
    return new Float32Array(src);
}

function mat4Multiply(a: Float32Array, b: Float32Array, out: Float32Array): Float32Array {
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

function mat4Translate(m: Float32Array, tx: number, ty: number, tz: number): void {
    // Post-multiply by translation: M = M * T
    // Column-major: T is identity except T[12]=tx, T[13]=ty, T[14]=tz
    for (let row = 0; row < 4; row++) {
        m[12 + row] += m[row] * tx + m[4 + row] * ty + m[8 + row] * tz;
    }
}

function mat4Scale(m: Float32Array, sx: number, sy: number, sz: number): void {
    // Post-multiply by scale: M = M * S
    for (let row = 0; row < 4; row++) {
        m[row] *= sx;
        m[4 + row] *= sy;
        m[8 + row] *= sz;
    }
}

function mat4Ortho(
    left: number, right: number,
    bottom: number, top: number,
    near: number, far: number,
): Float32Array {
    const m = new Float32Array(16);
    const rl = right - left;
    const tb = top - bottom;
    const fn = far - near;
    m[0] = 2 / rl;
    m[5] = 2 / tb;
    m[10] = -2 / fn;
    m[12] = -(right + left) / rl;
    m[13] = -(top + bottom) / tb;
    m[14] = -(far + near) / fn;
    m[15] = 1;
    return m;
}

function mat4Rotate(m: Float32Array, angleDeg: number, ax: number, ay: number, az: number): void {
    const rad = angleDeg * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const len = Math.sqrt(ax * ax + ay * ay + az * az);
    if (len < 1e-8) return;
    const nx = ax / len, ny = ay / len, nz = az / len;
    const t = 1 - c;
    const r = new Float32Array(16);
    r[0] = t * nx * nx + c;
    r[1] = t * nx * ny + s * nz;
    r[2] = t * nx * nz - s * ny;
    r[4] = t * nx * ny - s * nz;
    r[5] = t * ny * ny + c;
    r[6] = t * ny * nz + s * nx;
    r[8] = t * nx * nz + s * ny;
    r[9] = t * ny * nz - s * nx;
    r[10] = t * nz * nz + c;
    r[15] = 1;
    const tmp = new Float32Array(16);
    mat4Multiply(m, r, tmp);
    m.set(tmp);
}

// ── Matrix stack ────────────────────────────────────────────────────────

class MatrixStack {
    current: Float32Array;
    private stack: Float32Array[] = [];

    constructor() {
        this.current = mat4Identity();
    }

    push(): void {
        this.stack.push(mat4Copy(this.current));
    }

    pop(): void {
        const top = this.stack.pop();
        if (top) this.current = top;
    }

    loadIdentity(): void {
        this.current = mat4Identity();
    }

    loadMatrix(m: Float32Array): void {
        this.current.set(m);
    }

    translate(x: number, y: number, z: number): void {
        mat4Translate(this.current, x, y, z);
    }

    scale(x: number, y: number, z: number): void {
        mat4Scale(this.current, x, y, z);
    }

    rotate(angleDeg: number, x: number, y: number, z: number): void {
        mat4Rotate(this.current, angleDeg, x, y, z);
    }

    multMatrix(m: Float32Array): void {
        const tmp = new Float32Array(16);
        mat4Multiply(this.current, m, tmp);
        this.current.set(tmp);
    }
}

// ── Display list ────────────────────────────────────────────────────────

interface DisplayListDraw {
    type: 'draw';
    mode: number;
    vertexData: Float32Array;
    vertexCount: number;
    textured: boolean;
    boundTexture: WebGLTexture | null;
    /** True if no explicit gl.Color was set in the list before this draw —
     * the vertex colors were baked as (1,1,1,1) and the external current
     * color should be applied as a uniform tint at replay time. */
    useExternalColor: boolean;
}

interface DisplayListTexBind {
    type: 'texBind';
    unit: number;
    texture: WebGLTexture | null;
}

interface DisplayListMatrixOp {
    type: 'matrix';
    op: 'push' | 'pop' | 'identity' | 'translate' | 'scale' | 'rotate' | 'load' | 'mult' | 'ortho' | 'billboard';
    args?: number[];
    matrix?: Float32Array;
}

interface DisplayListColorOp {
    type: 'color';
    r: number;
    g: number;
    b: number;
    a: number;
}

type DisplayListEntry = DisplayListDraw | DisplayListTexBind | DisplayListMatrixOp | DisplayListColorOp;

interface DisplayList {
    entries: DisplayListEntry[];
}

// ── Main class ──────────────────────────────────────────────────────────

export class ImmediateModeRenderer {
    private gl: WebGL2RenderingContext;
    private program: WebGLProgram;
    private vao: WebGLVertexArrayObject;
    private vbo: WebGLBuffer;
    private uMVP: WebGLUniformLocation;
    private uTextured: WebGLUniformLocation;
    private uTex: WebGLUniformLocation;
    private uAlphaThreshold: WebGLUniformLocation;
    private uColor: WebGLUniformLocation;

    // Vertex accumulation buffer
    private vertices = new Float32Array(MAX_VERTICES * FLOATS_PER_VERTEX);
    private vertexCount = 0;
    private currentMode = GL_TRIANGLES;
    private inBeginEnd = false;

    // Current vertex attributes (set by gl.Color, gl.TexCoord, etc.)
    private curR = 1;
    private curG = 1;
    private curB = 1;
    private curA = 1;
    private curS = 0;
    private curT = 0;
    // Multi-texcoord per unit (unit 0 only used for now)
    private curMultiS: number[] = [0];
    private curMultiT: number[] = [0];

    // Matrix stacks
    private modelviewStack = new MatrixStack();
    private projectionStack = new MatrixStack();
    private currentMatrixMode = 0x1700; // GL_MODELVIEW
    private mvpDirty = true;
    private mvpCache = new Float32Array(16);

    // Current texture binding tracked for immediate mode
    private currentBoundTexture: WebGLTexture | null = null;
    private isTextured = false;

    // Alpha test threshold (0 = disabled)
    private alphaThreshold = 0;

    // Display lists
    private displayLists = new Map<number, DisplayList>();
    private nextListId = 1;
    private recordingList: DisplayList | null = null;
    /** Set true when an explicit gl.Color is recorded into the current list.
     * Until then, vertices emitted into the list bake (1,1,1,1) so external
     * gl.Color can tint the geometry at replay time via the uColor uniform. */
    private explicitColorInList = false;

    constructor(gl: WebGL2RenderingContext) {
        this.gl = gl;

        // Compile immediate-mode shader
        this.program = this.compileProgram(VS_SOURCE, FS_SOURCE);
        this.uMVP = gl.getUniformLocation(this.program, 'uMVP')!;
        this.uTextured = gl.getUniformLocation(this.program, 'uTextured')!;
        this.uTex = gl.getUniformLocation(this.program, 'uTex')!;
        this.uAlphaThreshold = gl.getUniformLocation(this.program, 'uAlphaThreshold')!;
        this.uColor = gl.getUniformLocation(this.program, 'uColor')!;

        // Create VAO + dynamic VBO
        this.vao = gl.createVertexArray()!;
        this.vbo = gl.createBuffer()!;
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);

        // aPos (location 0): 2 floats at offset 0
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, BYTES_PER_VERTEX, 0);
        // aColor (location 1): 4 floats at offset 8
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, BYTES_PER_VERTEX, 8);
        // aTexCoord (location 2): 2 floats at offset 24
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 2, gl.FLOAT, false, BYTES_PER_VERTEX, 24);

        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        // Default projection: identity (caller should set up ortho)
        this.projectionStack.loadIdentity();
        this.modelviewStack.loadIdentity();
    }

    // ── Matrix operations ───────────────────────────────────────────────

    private get activeStack(): MatrixStack {
        return this.currentMatrixMode === 0x1701
            ? this.projectionStack
            : this.modelviewStack;
    }

    matrixMode(mode: number): void {
        this.currentMatrixMode = mode;
    }

    pushMatrix(): void {
        this.activeStack.push();
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'push' });
        }
    }

    popMatrix(): void {
        this.activeStack.pop();
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'pop' });
        }
    }

    loadIdentity(): void {
        this.activeStack.loadIdentity();
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'identity' });
        }
    }

    loadMatrix(m: Float32Array): void {
        this.activeStack.loadMatrix(m);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'load', matrix: new Float32Array(m) });
        }
    }

    translate(x: number, y: number, z: number): void {
        this.activeStack.translate(x, y, z);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'translate', args: [x, y, z] });
        }
    }

    scale(x: number, y: number, z: number): void {
        this.activeStack.scale(x, y, z);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'scale', args: [x, y, z] });
        }
    }

    rotate(angle: number, x: number, y: number, z: number): void {
        this.activeStack.rotate(angle, x, y, z);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'rotate', args: [angle, x, y, z] });
        }
    }

    multMatrix(m: Float32Array): void {
        this.activeStack.multMatrix(m);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'mult', matrix: new Float32Array(m) });
        }
    }

    ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): void {
        const o = mat4Ortho(left, right, bottom, top, near, far);
        this.activeStack.multMatrix(o);
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'ortho', args: [left, right, bottom, top, near, far] });
        }
    }

    billboard(): void {
        // Reset the rotation part of modelview to identity (keep translation)
        const m = this.modelviewStack.current;
        m[0] = 1; m[1] = 0; m[2] = 0;
        m[4] = 0; m[5] = 1; m[6] = 0;
        m[8] = 0; m[9] = 0; m[10] = 1;
        this.mvpDirty = true;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'matrix', op: 'billboard' });
        }
    }

    private computeMVP(): Float32Array {
        if (this.mvpDirty) {
            mat4Multiply(
                this.projectionStack.current,
                this.modelviewStack.current,
                this.mvpCache,
            );
            this.mvpDirty = false;
        }
        return this.mvpCache;
    }

    // ── Vertex attribute state ──────────────────────────────────────────

    color(r: number, g: number, b: number, a: number): void {
        this.curR = r;
        this.curG = g;
        this.curB = b;
        this.curA = a;
        if (this.recordingList) {
            this.recordingList.entries.push({ type: 'color', r, g, b, a });
            this.explicitColorInList = true;
        }
    }

    texCoord(s: number, t: number): void {
        this.curS = s;
        this.curT = t;
    }

    multiTexCoord(unit: number, s: number, t: number): void {
        // We only use unit 0 for the immediate-mode shader
        if (unit === 0) {
            this.curS = s;
            this.curT = t;
        }
        while (this.curMultiS.length <= unit) {
            this.curMultiS.push(0);
            this.curMultiT.push(0);
        }
        this.curMultiS[unit] = s;
        this.curMultiT[unit] = t;
    }

    vertex(x: number, y: number): void {
        if (this.vertexCount >= MAX_VERTICES) return;
        const i = this.vertexCount * FLOATS_PER_VERTEX;
        this.vertices[i] = x;
        this.vertices[i + 1] = y;
        if (this.recordingList && !this.explicitColorInList) {
            this.vertices[i + 2] = 1;
            this.vertices[i + 3] = 1;
            this.vertices[i + 4] = 1;
            this.vertices[i + 5] = 1;
        } else {
            this.vertices[i + 2] = this.curR;
            this.vertices[i + 3] = this.curG;
            this.vertices[i + 4] = this.curB;
            this.vertices[i + 5] = this.curA;
        }
        this.vertices[i + 6] = this.curS;
        this.vertices[i + 7] = this.curT;
        this.vertexCount++;
    }

    // ── Texture tracking ────────────────────────────────────────────────

    setTextured(textured: boolean, tex: WebGLTexture | null): void {
        this.isTextured = textured;
        this.currentBoundTexture = tex;
    }

    // ── Alpha test ──────────────────────────────────────────────────────

    setAlphaThreshold(threshold: number): void {
        this.alphaThreshold = threshold;
    }

    // ── BeginEnd ────────────────────────────────────────────────────────

    beginEnd(mode: number, fn: () => void): void {
        this.currentMode = mode;
        this.vertexCount = 0;
        this.inBeginEnd = true;

        fn();

        this.inBeginEnd = false;

        if (this.vertexCount > 0) {
            if (this.recordingList) {
                // Record into display list instead of drawing
                this.recordingList.entries.push({
                    type: 'draw',
                    mode: this.currentMode,
                    vertexData: new Float32Array(
                        this.vertices.buffer, 0,
                        this.vertexCount * FLOATS_PER_VERTEX,
                    ).slice(),
                    vertexCount: this.vertexCount,
                    textured: this.isTextured,
                    boundTexture: this.currentBoundTexture,
                    useExternalColor: !this.explicitColorInList,
                });
            } else {
                this.flush(this.currentMode, this.vertexCount);
            }
        }
    }

    // ── Rect / TexRect ──────────────────────────────────────────────────

    rect(x1: number, y1: number, x2: number, y2: number): void {
        this.vertexCount = 0;
        // Emit as two triangles (GL_TRIANGLES)
        this.vertex(x1, y1);
        this.vertex(x2, y1);
        this.vertex(x2, y2);

        this.vertex(x1, y1);
        this.vertex(x2, y2);
        this.vertex(x1, y2);

        if (this.recordingList) {
            this.recordingList.entries.push({
                type: 'draw',
                mode: GL_TRIANGLES,
                vertexData: new Float32Array(
                    this.vertices.buffer, 0,
                    this.vertexCount * FLOATS_PER_VERTEX,
                ).slice(),
                vertexCount: this.vertexCount,
                textured: this.isTextured,
                boundTexture: this.currentBoundTexture,
                useExternalColor: !this.explicitColorInList,
            });
        } else {
            this.flush(GL_TRIANGLES, this.vertexCount);
        }
        this.vertexCount = 0;
    }

    texRect(x1: number, y1: number, x2: number, y2: number,
        s1 = 0, t1 = 0, s2 = 1, t2 = 1): void {
        this.vertexCount = 0;
        // Save/restore texcoord state
        const savedS = this.curS;
        const savedT = this.curT;

        this.curS = s1; this.curT = t1;
        this.vertex(x1, y1);
        this.curS = s2; this.curT = t1;
        this.vertex(x2, y1);
        this.curS = s2; this.curT = t2;
        this.vertex(x2, y2);

        this.curS = s1; this.curT = t1;
        this.vertex(x1, y1);
        this.curS = s2; this.curT = t2;
        this.vertex(x2, y2);
        this.curS = s1; this.curT = t2;
        this.vertex(x1, y2);

        this.curS = savedS;
        this.curT = savedT;

        if (this.recordingList) {
            this.recordingList.entries.push({
                type: 'draw',
                mode: GL_TRIANGLES,
                vertexData: new Float32Array(
                    this.vertices.buffer, 0,
                    this.vertexCount * FLOATS_PER_VERTEX,
                ).slice(),
                vertexCount: this.vertexCount,
                textured: this.isTextured,
                boundTexture: this.currentBoundTexture,
                useExternalColor: !this.explicitColorInList,
            });
        } else {
            this.flush(GL_TRIANGLES, this.vertexCount);
        }
        this.vertexCount = 0;
    }

    // ── Display lists ───────────────────────────────────────────────────

    /** Whether a display list is currently being recorded. */
    isRecording(): boolean {
        return this.recordingList !== null;
    }

    /** Record a texture bind into the current display list (called by bridge). */
    recordTextureBind(unit: number, texture: WebGLTexture | null): void {
        if (!this.recordingList) return;
        this.recordingList.entries.push({ type: 'texBind', unit, texture });
    }

    /** Expose current texture state so the bridge can sync after callList. */
    getTexturedState(): { textured: boolean; texture: WebGLTexture | null } {
        return { textured: this.isTextured, texture: this.currentBoundTexture };
    }

    createList(fn: () => void): number {
        const id = this.nextListId++;
        const list: DisplayList = { entries: [] };
        this.recordingList = list;
        this.explicitColorInList = false;
        fn();
        this.recordingList = null;
        this.explicitColorInList = false;
        this.displayLists.set(id, list);
        return id;
    }

    /** Start recording a display list (used by Lua-side gl.CreateList). */
    startRecording(): void {
        this.recordingList = { entries: [] };
        this.explicitColorInList = false;
    }

    /** Stop recording and store the display list. Returns the list ID. */
    stopRecording(): number {
        if (!this.recordingList) return 0;
        const list = this.recordingList;
        this.recordingList = null;
        this.explicitColorInList = false;
        const id = this.nextListId++;
        this.displayLists.set(id, list);
        return id;
    }

    callList(id: number): void {
        const list = this.displayLists.get(id);
        if (!list) return;

        // During recording: flatten the called list's entries into the parent list
        if (this.recordingList) {
            for (const entry of list.entries) {
                this.recordingList.entries.push(entry);
                // Also apply state changes so subsequent recording captures correct state
                if (entry.type === 'matrix') {
                    this.replayMatrixOp(entry);
                } else if (entry.type === 'texBind') {
                    if (entry.unit === 0) {
                        this.isTextured = entry.texture !== null;
                        this.currentBoundTexture = entry.texture;
                    }
                } else if (entry.type === 'color') {
                    this.curR = entry.r;
                    this.curG = entry.g;
                    this.curB = entry.b;
                    this.curA = entry.a;
                    this.explicitColorInList = true;
                } else if (entry.type === 'draw') {
                    this.isTextured = entry.textured;
                    this.currentBoundTexture = entry.boundTexture;
                }
            }
            return;
        }

        // Normal replay: execute entries
        for (const entry of list.entries) {
            if (entry.type === 'texBind') {
                const gl = this.gl;
                gl.activeTexture(gl.TEXTURE0 + entry.unit);
                if (entry.texture) {
                    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
                } else {
                    gl.bindTexture(gl.TEXTURE_2D, null);
                }
                if (entry.unit === 0) {
                    this.isTextured = entry.texture !== null;
                    this.currentBoundTexture = entry.texture;
                }
                gl.activeTexture(gl.TEXTURE0);
            } else if (entry.type === 'matrix') {
                this.replayMatrixOp(entry);
            } else if (entry.type === 'color') {
                this.curR = entry.r;
                this.curG = entry.g;
                this.curB = entry.b;
                this.curA = entry.a;
            } else {
                // Draw call — set texture state for this draw
                this.vertices.set(entry.vertexData);
                this.isTextured = entry.textured;
                this.currentBoundTexture = entry.boundTexture;
                // If the draw was recorded without an explicit gl.Color, its
                // vertex colors are (1,1,1,1); apply the current external color
                // as a uniform tint. Otherwise the recorded colors win and the
                // uniform is identity.
                const tint: [number, number, number, number] | null =
                    entry.useExternalColor
                        ? [this.curR, this.curG, this.curB, this.curA]
                        : null;
                this.flush(entry.mode, entry.vertexCount, tint);
            }
        }
    }

    /** Replay a matrix operation (shared between callList and recording). */
    private replayMatrixOp(entry: DisplayListMatrixOp): void {
        switch (entry.op) {
            case 'push': this.activeStack.push(); break;
            case 'pop': this.activeStack.pop(); this.mvpDirty = true; break;
            case 'identity': this.activeStack.loadIdentity(); this.mvpDirty = true; break;
            case 'translate': this.activeStack.translate(entry.args![0], entry.args![1], entry.args![2]); this.mvpDirty = true; break;
            case 'scale': this.activeStack.scale(entry.args![0], entry.args![1], entry.args![2]); this.mvpDirty = true; break;
            case 'rotate': this.activeStack.rotate(entry.args![0], entry.args![1], entry.args![2], entry.args![3]); this.mvpDirty = true; break;
            case 'load': this.activeStack.loadMatrix(entry.matrix!); this.mvpDirty = true; break;
            case 'mult': this.activeStack.multMatrix(entry.matrix!); this.mvpDirty = true; break;
            case 'ortho': {
                const a = entry.args!;
                const o = mat4Ortho(a[0], a[1], a[2], a[3], a[4], a[5]);
                this.activeStack.multMatrix(o);
                this.mvpDirty = true;
                break;
            }
            case 'billboard': {
                const m = this.modelviewStack.current;
                m[0] = 1; m[1] = 0; m[2] = 0;
                m[4] = 0; m[5] = 1; m[6] = 0;
                m[8] = 0; m[9] = 0; m[10] = 1;
                this.mvpDirty = true;
                break;
            }
        }
    }

    deleteList(id: number): void {
        this.displayLists.delete(id);
    }

    /** Debug: inspect display list contents. Returns entry type summary. */
    inspectList(id: number): string {
        const list = this.displayLists.get(id);
        if (!list) return `list ${id} not found`;
        const summary: Record<string, number> = {};
        for (const entry of list.entries) {
            const key = entry.type === 'matrix' ? `matrix:${entry.op}` : entry.type;
            summary[key] = (summary[key] || 0) + 1;
        }
        return JSON.stringify(summary);
    }

    // ── Flush to WebGL ──────────────────────────────────────────────────

    private flush(
        mode: number,
        count: number,
        tint: [number, number, number, number] | null = null,
    ): void {
        if (count === 0) return;
        const gl = this.gl;

        // Save state we'll overwrite
        const savedProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const savedVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);

        gl.useProgram(this.program);

        // Upload MVP
        gl.uniformMatrix4fv(this.uMVP, false, this.computeMVP());

        // Texture state
        gl.uniform1i(this.uTextured, this.isTextured ? 1 : 0);
        gl.uniform1i(this.uTex, 0); // texture unit 0
        if (this.isTextured && this.currentBoundTexture) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.currentBoundTexture);
        }
        gl.uniform1f(this.uAlphaThreshold, this.alphaThreshold);

        // Color tint uniform: identity for live draws (vertex colors carry the
        // value), external current color for replays of lists that had no
        // explicit gl.Color recorded.
        if (tint) {
            gl.uniform4f(this.uColor, tint[0], tint[1], tint[2], tint[3]);
        } else {
            gl.uniform4f(this.uColor, 1, 1, 1, 1);
        }


        // Upload vertex data
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

        if (mode === GL_QUADS) {
            // Convert quads to triangles
            const quadCount = Math.floor(count / 4);
            const triCount = quadCount * 6;
            const triVertices = new Float32Array(triCount * FLOATS_PER_VERTEX);
            let outIdx = 0;
            for (let q = 0; q < quadCount; q++) {
                const base = q * 4 * FLOATS_PER_VERTEX;
                // Triangle 1: v0, v1, v2
                for (let v = 0; v < 3; v++) {
                    const src = base + v * FLOATS_PER_VERTEX;
                    for (let f = 0; f < FLOATS_PER_VERTEX; f++) {
                        triVertices[outIdx++] = this.vertices[src + f];
                    }
                }
                // Triangle 2: v0, v2, v3
                const v0 = base;
                const v2 = base + 2 * FLOATS_PER_VERTEX;
                const v3 = base + 3 * FLOATS_PER_VERTEX;
                for (let f = 0; f < FLOATS_PER_VERTEX; f++) triVertices[outIdx++] = this.vertices[v0 + f];
                for (let f = 0; f < FLOATS_PER_VERTEX; f++) triVertices[outIdx++] = this.vertices[v2 + f];
                for (let f = 0; f < FLOATS_PER_VERTEX; f++) triVertices[outIdx++] = this.vertices[v3 + f];
            }
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, triVertices);
            gl.drawArrays(gl.TRIANGLES, 0, triCount);
        } else {
            const sub = this.vertices.subarray(0, count * FLOATS_PER_VERTEX);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, sub);
            // Map Spring mode to WebGL mode
            const glMode = this.mapMode(mode);
            gl.drawArrays(glMode, 0, count);
        }

        // Restore state
        gl.bindVertexArray(savedVao);
        gl.useProgram(savedProgram);
    }

    private mapMode(mode: number): number {
        const gl = this.gl;
        switch (mode) {
            case GL_POINTS: return gl.POINTS;
            case GL_LINES: return gl.LINES;
            case GL_LINE_LOOP: return gl.LINE_LOOP;
            case GL_LINE_STRIP: return gl.LINE_STRIP;
            case GL_TRIANGLES: return gl.TRIANGLES;
            case GL_TRIANGLE_STRIP: return gl.TRIANGLE_STRIP;
            case GL_TRIANGLE_FAN: return gl.TRIANGLE_FAN;
            default: return gl.TRIANGLES;
        }
    }

    // ── Shader compilation ──────────────────────────────────────────────

    private compileProgram(vsSrc: string, fsSrc: string): WebGLProgram {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, vsSrc);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(vs);
            gl.deleteShader(vs);
            throw new Error(`Immediate-mode VS compile failed: ${log}`);
        }

        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, fsSrc);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(fs);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            throw new Error(`Immediate-mode FS compile failed: ${log}`);
        }

        const prog = gl.createProgram()!;
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(prog);
            gl.deleteProgram(prog);
            gl.deleteShader(vs);
            gl.deleteShader(fs);
            throw new Error(`Immediate-mode link failed: ${log}`);
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return prog;
    }

    dispose(): void {
        const gl = this.gl;
        gl.deleteProgram(this.program);
        gl.deleteVertexArray(this.vao);
        gl.deleteBuffer(this.vbo);
        this.displayLists.clear();
    }
}
