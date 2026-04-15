/**
 * LuaGLFont — runtime glyph atlas font renderer for the Spring gl.LoadFont API.
 *
 * Rasterizes glyphs on demand via an offscreen Canvas2D, packs them into a
 * WebGL texture atlas (shelf-based), and renders text as textured quads
 * through ImmediateModeRenderer.
 *
 * Kerning is computed from Canvas2D measurements for common alphanumeric
 * pairs at font load time.
 */
import type { ImmediateModeRenderer } from './lua-gl-immediate.js';
import type { LuaValue } from './lua-runtime.js';

// ── Kerning pair definitions ────────────────────────────────────────────
// Common pairs that typically need negative kerning in Latin fonts.
// We compute actual values from Canvas2D at font creation time.
const KERN_PAIRS: [string, string][] = [
    // Caps + caps/lowercase
    ['A', 'V'], ['A', 'W'], ['A', 'Y'], ['A', 'T'], ['A', 'v'], ['A', 'w'], ['A', 'y'],
    ['A', 'C'], ['A', 'G'], ['A', 'O'], ['A', 'Q'], ['A', 'U'],
    ['F', 'A'], ['F', 'a'], ['F', 'e'], ['F', 'o'], ['F', 'i'], ['F', 'r'], ['F', '.'], ['F', ','],
    ['L', 'T'], ['L', 'V'], ['L', 'W'], ['L', 'Y'], ['L', 'y'],
    ['P', 'A'], ['P', 'a'], ['P', 'e'], ['P', 'o'], ['P', '.'], ['P', ','],
    ['T', 'A'], ['T', 'a'], ['T', 'e'], ['T', 'i'], ['T', 'o'], ['T', 'r'], ['T', 'u'], ['T', 'y'],
    ['T', 'w'], ['T', '.'], ['T', ','], ['T', '-'],
    ['V', 'A'], ['V', 'a'], ['V', 'e'], ['V', 'i'], ['V', 'o'], ['V', 'u'], ['V', '.'], ['V', ','],
    ['W', 'A'], ['W', 'a'], ['W', 'e'], ['W', 'i'], ['W', 'o'], ['W', '.'], ['W', ','],
    ['Y', 'A'], ['Y', 'a'], ['Y', 'e'], ['Y', 'i'], ['Y', 'o'], ['Y', 'u'], ['Y', 'p'],
    ['Y', '.'], ['Y', ','], ['Y', '-'],
    // Lowercase pairs
    ['r', '.'], ['r', ','], ['r', 'a'],
    ['f', '.'], ['f', ','], ['f', 'a'],
    // Number pairs
    ['1', '1'], ['7', '4'],
];

// ── Glyph atlas types ───────────────────────────────────────────────────

interface GlyphEntry {
    /** Atlas position */
    x: number;
    y: number;
    w: number;
    h: number;
    /** Advance width in pixels */
    advance: number;
    /** Vertical offset from baseline to top of glyph */
    bearingY: number;
    /** Horizontal offset from cursor to left of glyph */
    bearingX: number;
}

interface ShelfRow {
    y: number;
    height: number;
    cursor: number; // next free x position
}

// ── Main class ──────────────────────────────────────────────────────────

const ATLAS_SIZE = 1024;
const GLYPH_PAD = 2; // padding between glyphs in atlas

export class GlyphAtlas {
    private gl: WebGL2RenderingContext;
    private canvas: OffscreenCanvas;
    private ctx: OffscreenCanvasRenderingContext2D;
    private texture: WebGLTexture;
    private glyphs = new Map<string, GlyphEntry>();
    private shelves: ShelfRow[] = [];
    private atlasWidth = ATLAS_SIZE;
    private atlasHeight = ATLAS_SIZE;
    private dirty = false;

    /** Font CSS string used for Canvas2D rendering */
    readonly cssFont: string;
    /** Actual rendered font size in pixels */
    readonly fontSize: number;

    /** Normalised line height (multiply by size for pixels) */
    lineheight: number;
    /** Normalised descender (negative, multiply by size for pixels) */
    descender: number;

    /** Kerning table: "AB" → pixel offset */
    private kernTable = new Map<string, number>();

    constructor(
        gl: WebGL2RenderingContext,
        fontFamily: string,
        fontSize: number,
        outlineWidth: number,
    ) {
        this.gl = gl;
        this.fontSize = fontSize;

        // Map Spring font names to CSS font families
        const family = mapFontFamily(fontFamily);
        const cssSize = Math.max(8, Math.round(fontSize));

        // Include outline width in the rendering size so outlines don't clip
        const renderSize = cssSize + outlineWidth * 2;
        this.cssFont = `${renderSize}px ${family}`;

        // Create offscreen canvas for glyph rasterization
        this.canvas = new OffscreenCanvas(this.atlasWidth, this.atlasHeight);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

        // Measure font metrics
        this.ctx.font = this.cssFont;
        this.ctx.textBaseline = 'alphabetic';
        const metrics = this.ctx.measureText('Hg|ÅÖ');
        const ascent = metrics.actualBoundingBoxAscent ?? cssSize * 0.8;
        const descent = metrics.actualBoundingBoxDescent ?? cssSize * 0.2;
        this.lineheight = (ascent + descent) / cssSize;
        this.descender = -descent / cssSize;

        // Create WebGL texture
        this.texture = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8,
            this.atlasWidth, this.atlasHeight, 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Compute kerning pairs
        this.computeKerning();

        // Pre-rasterize printable ASCII
        for (let c = 32; c < 127; c++) {
            this.getGlyph(String.fromCharCode(c));
        }
        this.uploadAtlas();
    }

    /** Compute kerning values for common pairs using Canvas2D measurements. */
    private computeKerning(): void {
        const ctx = this.ctx;
        ctx.font = this.cssFont;

        for (const [a, b] of KERN_PAIRS) {
            const wPair = ctx.measureText(a + b).width;
            const wA = ctx.measureText(a).width;
            const wB = ctx.measureText(b).width;
            const kern = wPair - wA - wB;
            // Only store if the kerning is significant (> 0.5px)
            if (Math.abs(kern) > 0.5) {
                this.kernTable.set(a + b, kern);
            }
        }
    }

    /** Get kerning between two characters in pixels. */
    getKerning(a: string, b: string): number {
        return this.kernTable.get(a + b) ?? 0;
    }

    /** Get or rasterize a glyph. Returns its atlas entry. */
    getGlyph(char: string): GlyphEntry {
        const existing = this.glyphs.get(char);
        if (existing) return existing;

        const ctx = this.ctx;
        ctx.font = this.cssFont;
        ctx.textBaseline = 'alphabetic';

        // Measure the character
        const metrics = ctx.measureText(char);
        const advance = metrics.width;
        const bearingX = -(metrics.actualBoundingBoxLeft ?? 0);
        const ascent = metrics.actualBoundingBoxAscent ?? this.fontSize * 0.8;
        const descent = metrics.actualBoundingBoxDescent ?? this.fontSize * 0.2;
        const glyphW = Math.ceil(Math.abs(bearingX) + advance) + GLYPH_PAD * 2;
        const glyphH = Math.ceil(ascent + descent) + GLYPH_PAD * 2;

        // Find or create a shelf row
        const pos = this.allocateShelf(glyphW, glyphH);
        if (!pos) {
            // Atlas full — return a zero-size entry
            const entry: GlyphEntry = {
                x: 0, y: 0, w: 0, h: 0,
                advance, bearingY: ascent, bearingX,
            };
            this.glyphs.set(char, entry);
            return entry;
        }

        // Rasterize into the atlas canvas
        // Clear the glyph area first
        ctx.clearRect(pos.x, pos.y, glyphW, glyphH);

        // Draw the glyph
        ctx.font = this.cssFont;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'white';
        ctx.fillText(char, pos.x + GLYPH_PAD - bearingX, pos.y + GLYPH_PAD + ascent);

        const entry: GlyphEntry = {
            x: pos.x,
            y: pos.y,
            w: glyphW,
            h: glyphH,
            advance,
            bearingY: ascent,
            bearingX,
        };
        this.glyphs.set(char, entry);
        this.dirty = true;
        return entry;
    }

    /** Allocate space in the shelf-based atlas packer. */
    private allocateShelf(w: number, h: number): { x: number; y: number } | null {
        // Try to fit in an existing shelf
        for (const shelf of this.shelves) {
            if (shelf.height >= h && shelf.cursor + w <= this.atlasWidth) {
                const pos = { x: shelf.cursor, y: shelf.y };
                shelf.cursor += w;
                return pos;
            }
        }

        // Create a new shelf
        const lastShelf = this.shelves[this.shelves.length - 1];
        const newY = lastShelf ? lastShelf.y + lastShelf.height : 0;
        if (newY + h > this.atlasHeight) return null; // atlas full

        const shelf: ShelfRow = { y: newY, height: h, cursor: w };
        this.shelves.push(shelf);
        return { x: 0, y: newY };
    }

    /** Upload the canvas to the WebGL texture. */
    uploadAtlas(): void {
        if (!this.dirty) return;
        this.dirty = false;
        const gl = this.gl;
        const saved = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.bindTexture(gl.TEXTURE_2D, this.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
        gl.bindTexture(gl.TEXTURE_2D, saved);
    }

    getTexture(): WebGLTexture {
        return this.texture;
    }

    dispose(): void {
        this.gl.deleteTexture(this.texture);
    }
}

// ── Font handle (returned to Lua) ──────────────────────────────────────

/**
 * Creates a Lua-compatible font object. Methods accept `self` as first arg
 * because Lua's `:` syntax passes the table automatically.
 */
export function createLuaFontObject(
    gl: WebGL2RenderingContext,
    imm: ImmediateModeRenderer,
    fontPath: string,
    fontSize: number,
    outlineWidth: number,
    outlineWeight: number,
): Record<string, LuaValue> {
    const atlas = new GlyphAtlas(gl, fontPath, fontSize, outlineWidth);

    let textColor = [1, 1, 1, 1];
    let outlineColor = [0, 0, 0, 1];
    let _autoOutlineColor = true;

    const font: Record<string, LuaValue> = {
        // Fields
        size: fontSize,
        path: fontPath,
        lineheight: atlas.lineheight,
        descender: atlas.descender,
        outlinewidth: outlineWidth,
        outlineweight: outlineWeight,

        // Batch mode (no-op — we draw immediately)
        Begin: (_self: LuaValue) => { },
        End: (_self: LuaValue) => {
            // Upload any newly rasterized glyphs
            atlas.uploadAtlas();
        },

        SetTextColor: (_self: LuaValue, colorOrR: LuaValue, g?: LuaValue, b?: LuaValue, a?: LuaValue) => {
            if (Array.isArray(colorOrR)) {
                textColor = colorOrR.map(Number);
            } else if (typeof colorOrR === 'object' && colorOrR !== null) {
                // Lua table passed as object
                const vals = Object.values(colorOrR as Record<string, LuaValue>);
                textColor = vals.map(Number);
            } else {
                textColor = [
                    Number(colorOrR ?? 1),
                    Number(g ?? 1),
                    Number(b ?? 1),
                    Number(a ?? 1),
                ];
            }
        },

        SetOutlineColor: (_self: LuaValue, colorOrR: LuaValue, g?: LuaValue, b?: LuaValue, a?: LuaValue) => {
            if (Array.isArray(colorOrR)) {
                outlineColor = colorOrR.map(Number);
            } else if (typeof colorOrR === 'object' && colorOrR !== null) {
                const vals = Object.values(colorOrR as Record<string, LuaValue>);
                outlineColor = vals.map(Number);
            } else {
                outlineColor = [
                    Number(colorOrR ?? 0),
                    Number(g ?? 0),
                    Number(b ?? 0),
                    Number(a ?? 1),
                ];
            }
        },

        SetAutoOutlineColor: (_self: LuaValue, on: LuaValue) => {
            _autoOutlineColor = !!on;
        },

        /**
         * font:Print(text, x, y, size, options)
         *
         * options is a string of flag chars:
         *   c = horizontal center, r = right align
         *   v = vertical center, a = ascender (top), t = top, b = bottom
         *   x = linecenter
         *   o = outline, s = shadow
         *   n = no color codes, d = depth test
         */
        Print: (_self: LuaValue, text: LuaValue, x: LuaValue, y: LuaValue,
            sizeOrAlign: LuaValue, extraOrValign: LuaValue) => {
            const str = String(text ?? '');
            if (!str) return;

            let px = Number(x ?? 0);
            let py = Number(y ?? 0);
            let drawSize = fontSize;
            let flags = '';

            // Spring's font:Print has two call conventions:
            // font:Print(text, x, y, size, "flags")  — from FontHandler
            // font:Print(text, x, y, "halign", "valign") — from Chili Font:Draw
            if (typeof sizeOrAlign === 'number') {
                drawSize = sizeOrAlign;
                flags = String(extraOrValign ?? '');
            } else if (typeof sizeOrAlign === 'string') {
                // Chili-style: align params instead of size
                flags = sizeOrAlign + String(extraOrValign ?? '');
            }

            // Measure text width for alignment
            const scale = drawSize / atlas.fontSize;
            const textW = measureText(atlas, str) * scale;
            const textH = atlas.lineheight * drawSize;

            // Horizontal alignment
            if (flags.includes('c')) px -= textW / 2;
            else if (flags.includes('r')) px -= textW;

            // Vertical alignment
            if (flags.includes('v')) {
                py -= textH / 2;
            } else if (flags.includes('x')) {
                // linecenter — already adjusted by caller
            } else if (flags.includes('a')) {
                // ascender — draw from top
            } else if (flags.includes('t')) {
                // top
            } else if (flags.includes('b')) {
                py -= textH;
            }

            const drawOutline = flags.includes('o') && outlineWidth > 0;
            const drawShadow = flags.includes('s');

            // Upload any pending glyphs
            atlas.uploadAtlas();

            // Draw shadow pass
            if (drawShadow) {
                const shadowOff = Math.max(1, drawSize * 0.06);
                renderString(atlas, imm, gl, str, px + shadowOff, py + shadowOff,
                    scale, [0, 0, 0, textColor[3] * 0.6]);
            }

            // Draw outline pass (4 offset copies)
            if (drawOutline) {
                const ow = outlineWidth * scale;
                const offsets = [
                    [-ow, 0], [ow, 0], [0, -ow], [0, ow],
                    [-ow * 0.7, -ow * 0.7], [ow * 0.7, -ow * 0.7],
                    [-ow * 0.7, ow * 0.7], [ow * 0.7, ow * 0.7],
                ];
                for (const [ox, oy] of offsets) {
                    renderString(atlas, imm, gl, str, px + ox, py + oy,
                        scale, outlineColor);
                }
            }

            // Draw main text
            renderString(atlas, imm, gl, str, px, py, scale, textColor);
        },

        /**
         * font:GetTextWidth(text) — returns normalised width
         * (multiply by size to get pixels)
         */
        GetTextWidth: (_self: LuaValue, text: LuaValue) => {
            const str = String(text ?? '');
            return measureText(atlas, str) / atlas.fontSize;
        },

        /**
         * font:GetTextHeight(text) — returns height, descender, numlines
         * All normalised (multiply by size for pixels).
         */
        GetTextHeight: (_self: LuaValue, text: LuaValue) => {
            const str = String(text ?? '');
            const lines = str.split('\n');
            const numlines = lines.length;
            const h = atlas.lineheight * numlines;
            return [h, atlas.descender, numlines];
        },

        /**
         * font:WrapText(text, width, height, size) — word wrap
         */
        WrapText: (_self: LuaValue, text: LuaValue, width: LuaValue,
            _height: LuaValue, size: LuaValue) => {
            const str = String(text ?? '');
            const maxW = Number(width ?? 9999);
            const sz = Number(size ?? fontSize);
            const scale = sz / atlas.fontSize;

            const words = str.split(' ');
            const lines: string[] = [];
            let currentLine = '';

            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                const testW = measureText(atlas, testLine) * scale;
                if (testW > maxW && currentLine) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            if (currentLine) lines.push(currentLine);
            return lines.join('\n');
        },
    };

    return font;
}

// ── Text measurement ────────────────────────────────────────────────────

/** Measure text width in atlas-native pixels (before scaling). */
function measureText(atlas: GlyphAtlas, text: string): number {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') continue;
        // Strip Spring color codes: \255\r\g\b (4 bytes)
        if (ch === '\xff' && i + 3 < text.length) {
            i += 3;
            continue;
        }
        const glyph = atlas.getGlyph(ch);
        width += glyph.advance;
        // Kerning with next character
        if (i + 1 < text.length) {
            width += atlas.getKerning(ch, text[i + 1]);
        }
    }
    return width;
}

// ── String rendering ────────────────────────────────────────────────────

/** Render a string as textured quads through the immediate-mode renderer. */
function renderString(
    atlas: GlyphAtlas,
    imm: ImmediateModeRenderer,
    gl: WebGL2RenderingContext,
    text: string,
    x: number,
    y: number,
    scale: number,
    color: number[],
): void {
    // Bind atlas texture
    const savedTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.getTexture());

    imm.setTextured(true, atlas.getTexture());
    imm.color(color[0], color[1], color[2], color[3] ?? 1);

    const invW = 1 / ATLAS_SIZE;
    const invH = 1 / ATLAS_SIZE;
    let cursorX = x;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        // Handle newlines
        if (ch === '\n') {
            cursorX = x;
            y += atlas.lineheight * atlas.fontSize * scale;
            continue;
        }

        // Strip Spring color codes: \255\r\g\b
        if (ch === '\xff' && i + 3 < text.length) {
            const r = text.charCodeAt(i + 1) / 255;
            const g = text.charCodeAt(i + 2) / 255;
            const b = text.charCodeAt(i + 3) / 255;
            imm.color(r, g, b, color[3] ?? 1);
            i += 3;
            continue;
        }

        const glyph = atlas.getGlyph(ch);
        if (glyph.w > 0 && glyph.h > 0) {
            // Quad corners in screen space
            const qx = cursorX + glyph.bearingX * scale;
            const qy = y + (atlas.lineheight * atlas.fontSize - glyph.bearingY) * scale
                - GLYPH_PAD * scale;
            const qw = glyph.w * scale;
            const qh = glyph.h * scale;

            // Texture coordinates
            const u0 = glyph.x * invW;
            const v0 = glyph.y * invH;
            const u1 = (glyph.x + glyph.w) * invW;
            const v1 = (glyph.y + glyph.h) * invH;

            imm.texRect(qx, qy, qx + qw, qy + qh, u0, v0, u1, v1);
        }

        cursorX += glyph.advance * scale;

        // Kerning
        if (i + 1 < text.length) {
            cursorX += atlas.getKerning(ch, text[i + 1]) * scale;
        }
    }

    // Restore previous texture binding
    gl.bindTexture(gl.TEXTURE_2D, savedTex);
}

// ── Font name mapping ───────────────────────────────────────────────────

/** Map Spring font file names to CSS font-family values. */
function mapFontFamily(springName: string): string {
    const lower = springName.toLowerCase();

    // Strip path prefix and extension
    const base = lower
        .replace(/^fonts\//, '')
        .replace(/\.(otf|ttf|fnt)$/, '');

    // Common Spring fonts → system font stacks
    if (base.includes('freesansbold') || base.includes('freesans'))
        return '"FreeSans", "Liberation Sans", Arial, Helvetica, sans-serif';
    if (base.includes('freemono'))
        return '"FreeMono", "Liberation Mono", "Courier New", monospace';
    if (base.includes('freeserif'))
        return '"FreeSerif", "Liberation Serif", "Times New Roman", serif';
    if (base.includes('dejavu'))
        return '"DejaVu Sans", "Liberation Sans", Arial, sans-serif';

    // Fallback: use the name as-is wrapped in quotes, with sans-serif fallback
    return `"${springName}", sans-serif`;
}

// ── Dispose helper ──────────────────────────────────────────────────────

export function disposeLuaFont(font: Record<string, LuaValue>): void {
    // The atlas is captured in closure — nothing to do from outside
    // unless we track them. For now, rely on GC.
}
