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
    /** Font global ascent in pixels at the rasterised cssSize. Used by
     *  renderString to position each glyph by its baseline. */
    ascentPx: number;
    /** Cap-height ascent in pixels (no diacritic marks). Used for visual
     *  centring on buttons/labels — `ascentPx` includes the topmost
     *  diacritic dot of Å/Ö which sits well above cap height, biasing
     *  centred text upward by 3-5 px on common sans-serif fonts. */
    centerAscentPx: number;
    /** Descent in pixels at the rasterised cssSize (positive value). */
    descentPx: number;

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

        // Rasterize at the requested size — outlines are drawn at render
        // time via offset passes (see Print's drawOutline branch), not
        // baked into the glyph bitmap. Inflating the atlas size by the
        // outline width would oversize every glyph quad by ~30% (size 20
        // outlineW 3 → glyphs occupy 32 px line cells instead of 22),
        // breaking Chili layouts that assume the natural font lineheight.
        const renderSize = cssSize;
        this.cssFont = `${renderSize}px ${family}`;

        // Create offscreen canvas for glyph rasterization
        this.canvas = new OffscreenCanvas(this.atlasWidth, this.atlasHeight);
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

        // Measure font metrics. Glyph quads in the atlas are sized to
        // (ascent + descent + 2*GLYPH_PAD), and ascent/descent are measured
        // at renderSize (which includes the outline expansion). So the
        // *quad* height is bigger than `cssSize`. Lineheight has to include
        // both the outline expansion (already in the measured ascent/descent)
        // AND the atlas padding, otherwise wrapped lines stack with the
        // glyph quads overlapping into the next line. Without the +2*PAD
        // term, a size=20 outlineWidth=3 font has glyph quads ≈32px tall
        // but lineheight only ≈28px — wrapped lines overlap by ~4px.
        this.ctx.font = this.cssFont;
        this.ctx.textBaseline = 'alphabetic';
        // Probe with a string that contains the deepest descenders ('y', 'g',
        // 'p', 'j', 'Q') AND the highest ascenders (caps + diacritics 'Å',
        // 'Ö'). Missing 'y' and 'p' from the probe makes the descent value
        // ~0.8px too small, which causes 'y' descenders to overlap into the
        // next line.
        const metrics = this.ctx.measureText('HgypjQ|ÅÖ');
        const ascent = metrics.actualBoundingBoxAscent ?? cssSize * 0.8;
        const descent = metrics.actualBoundingBoxDescent ?? cssSize * 0.2;
        this.lineheight = (ascent + descent + GLYPH_PAD * 2) / cssSize;
        this.descender = -descent / cssSize;
        this.ascentPx = ascent;
        this.descentPx = descent;
        // Cap-height-only ascent: probe a string with the *visual top* at
        // cap height (no diacriticals). Used for visual centring so caps
        // like "CLOSE" don't sit 3-5 px above the button's geometric centre
        // because of unused space reserved for accent marks.
        const capMetrics = this.ctx.measureText('Hg');
        this.centerAscentPx = capMetrics.actualBoundingBoxAscent ?? cssSize * 0.7;

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

            // Spring's font:Print has two call conventions:
            //   font:Print(text, x, y, size,    "flagsString")        — FontHandler
            //   font:Print(text, x, y, "halign", "valign")            — Chili Font:Draw
            // For Chili we get full words like "center" / "linecenter".
            // For FontHandler we get a flag string of single chars like "cv" /
            // "cs" / "rxs". The two namespaces overlap (e.g. "center" contains
            // 'c', 'r', 't', etc.), so we can't just substring-match the whole
            // thing — we need to recognise full words first.
            let alignWord = '';
            let valignWord = '';
            let flagChars = '';
            if (typeof sizeOrAlign === 'number') {
                drawSize = sizeOrAlign;
                flagChars = String(extraOrValign ?? '');
            } else if (typeof sizeOrAlign === 'string') {
                alignWord = sizeOrAlign;
                valignWord = String(extraOrValign ?? '');
            }

            // Measure text width for alignment
            const scale = drawSize / atlas.fontSize;
            const textW = measureText(atlas, str) * scale;
            // Visual text height for centring: use cap-height ascent (no
            // diacritic offset) + descent. `atlas.ascentPx` includes the
            // topmost extent of Å/Ö dots which is 3-5 px above cap height
            // — using it for valign='v' biases caps like "CLOSE" upward
            // by that amount. centerAscentPx is the cap-only ascent.
            const visualH = (atlas.centerAscentPx + atlas.descentPx) * scale;
            const lineH = atlas.lineheight * drawSize;

            // Horizontal alignment
            const wantCenterX = alignWord === 'center' || flagChars.includes('c');
            const wantRight   = alignWord === 'right'  || flagChars.includes('r');
            if (wantCenterX) px -= textW / 2;
            else if (wantRight) px -= textW;

            // Vertical alignment.
            // renderString translates to (x, py) then Scale(1,-1,1) so glyph
            // quads emit with Y-down internally. With NO flag, glyphs emit
            // with their top approximately at py — i.e. "no flag" = text top
            // at y in the *outer* frame. To move text UP (toward the centre)
            // we ADD to py, since the glyph quads' qy values then translate
            // to a smaller world y.
            const wantCenterY    = valignWord === 'center'     || flagChars.includes('v');
            const wantLineCenter = valignWord === 'linecenter' || flagChars.includes('x');
            const wantBottom     = valignWord === 'bottom'     || flagChars.includes('b');
            if (wantCenterY) {
                // Centre the visible glyph bounds, not the line cell.
                py += visualH / 2;
            } else if (wantLineCenter) {
                // 'x' (linecenter): in Spring's font handler this means
                // "line baseline so that line CENTER is at y". Chili's
                // skin DrawButton/Font:DrawInBox both pre-adjust y to
                // compensate for the cap-vs-line-centre offset (e.g.
                // skinutils.DrawButton: y = button_y + h/2 - size*0.35),
                // so by the time we receive 'x', y is already at the
                // correct *baseline-relative* anchor — adding visualH/2
                // here would double-adjust and shift text UP by ~visualH/2.
                // No additional offset; the caller's pre-adjustment is
                // what positions the text.
            } else if (wantBottom) {
                py += visualH;
            }
            // 'top' / 'ascender' / no flag = no adjustment (text top at y).

            const drawOutline = flagChars.includes('o') && outlineWidth > 0;
            const drawShadow  = flagChars.includes('s');

            // Upload any pending glyphs
            atlas.uploadAtlas();

            // Draw shadow pass
            if (drawShadow) {
                const shadowOff = Math.max(1, drawSize * 0.06);
                renderString(atlas, imm, gl, str, px + shadowOff, py + shadowOff,
                    scale, [0, 0, 0, textColor[3] * 0.6]);
            }

            // Draw outline pass.
            // Spring's native renderer pre-bakes a Gaussian-blurred outline
            // into the atlas. We approximate with 4 offset copies at the
            // outline width — fewer samples than the previous 8-position
            // pattern (which over-saturated edges into a "bold" look). Per-
            // pass alpha is reduced so the cumulative coverage matches an
            // anti-aliased outline rather than stacking to full opacity.
            if (drawOutline) {
                const ow = outlineWidth * scale;
                // outlineWeight (0..4 typically, default 3) scales alpha so
                // higher weights produce a more saturated outline. Each pass
                // contributes ~1/4 of the alpha; clamp to 1.
                const weightAlpha = Math.min(1, (outlineWeight || 1) / 4);
                const passAlpha = (outlineColor[3] ?? 1) * weightAlpha;
                const oc = [outlineColor[0], outlineColor[1], outlineColor[2], passAlpha];
                const offsets = [
                    [-ow, 0], [ow, 0], [0, -ow], [0, ow],
                ];
                for (const [ox, oy] of offsets) {
                    renderString(atlas, imm, gl, str, px + ox, py + oy,
                        scale, oc);
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
    let lineWidth = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') {
            // Track widest line for multi-line strings.
            if (lineWidth > width) width = lineWidth;
            lineWidth = 0;
            continue;
        }
        // Strip Spring color codes: \255\r\g\b (4 bytes)
        if (ch === '\xff' && i + 3 < text.length) {
            i += 3;
            continue;
        }
        // Skip Spring "pop colour" (\b) and other low-control bytes — these
        // are formatting markers, not glyphs. Without this, Canvas2D draws
        // the codepoint's tofu/replacement glyph (a small accented box).
        const code = ch.charCodeAt(0);
        if (code < 0x20 && code !== 0x09) continue;
        const glyph = atlas.getGlyph(ch);
        lineWidth += glyph.advance;
        // Kerning with next character
        if (i + 1 < text.length) {
            lineWidth += atlas.getKerning(ch, text[i + 1]);
        }
    }
    if (lineWidth > width) width = lineWidth;
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
    // Chili applies Scale(1,-1,1) to the modelview, which flips glyph quads
    // upside-down. We locally un-flip Y around the text baseline position:
    // translate to (x,y), scale Y by -1 to undo the parent flip, then draw
    // glyphs at local coords (0,0)+. This keeps the position correct while
    // rendering text right-side-up.
    imm.pushMatrix();
    imm.translate(x, y, 0);
    imm.scale(1, -1, 1);

    // Bind atlas texture
    const savedTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.getTexture());

    imm.setTextured(true, atlas.getTexture());
    imm.color(color[0], color[1], color[2], color[3] ?? 1);

    const invW = 1 / ATLAS_SIZE;
    const invH = 1 / ATLAS_SIZE;
    // Use local coordinates (0-based) since we translated to (x,y) above
    let cursorX = 0;
    let localY = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        // Handle newlines
        if (ch === '\n') {
            cursorX = 0;
            localY += atlas.lineheight * atlas.fontSize * scale;
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

        // Spring "pop colour" marker (\b) restores the base colour. Other
        // low-control bytes (apart from \t) have no glyph — skip them so
        // Canvas2D doesn't render a tofu box.
        const code = ch.charCodeAt(0);
        if (code === 0x08) {
            imm.color(color[0], color[1], color[2], color[3] ?? 1);
            continue;
        }
        if (code < 0x20 && code !== 0x09) continue;

        const glyph = atlas.getGlyph(ch);
        if (glyph.w > 0 && glyph.h > 0) {
            // Quad corners in local space (translate already applied).
            // We anchor the line so that the visible top of a glyph with the
            // font's full ascent (e.g. 'H') sits at qy=0 — i.e. the local
            // origin. The line baseline is therefore at qy = ascent.
            // Each glyph's quad top is offset from the baseline by its own
            // bearingY (the height of the glyph above the baseline), so
            // qy = (ascent - bearingY) - PAD
            // The -PAD term accounts for the atlas-internal padding above
            // each glyph in its cell (visible top vs cell top).
            // Result: glyphs of different ascent share a baseline (so 'g'
            // descends below the same line as 'A' rests on), while line
            // top is at the local origin for "no flag" / 'a' / 't' semantics.
            const qx = cursorX + glyph.bearingX * scale;
            const qy = localY + (atlas.ascentPx - glyph.bearingY) * scale
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

    // Restore modelview (undo the loadIdentity we did at the top)
    imm.popMatrix();
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
