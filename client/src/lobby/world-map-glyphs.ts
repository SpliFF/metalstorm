/**
 * world-map-glyphs.ts — the marker shapes of the World screen.
 *
 * One table of unit-radius outlines, read by two renderers: the canvas
 * (`traceGlyph`, a path in a `WorldCtx`) and the legend (`glyphSvg`, an
 * inline `<svg>` string). They share the point table so the legend cannot
 * drift from the map — a legend that shows a hexagon for "foundry" while the
 * canvas draws a square is the kind of lie a screenshot check does not catch
 * because both halves look fine on their own.
 *
 * No external assets: every glyph is a handful of numbers, which is also why
 * they scale with the marker radius rather than being bitmaps.
 */

import type { WorldPoi } from './world-map.js';

/// The glyph vocabulary. `battleground` is any POI that stages a battle map;
/// `region` is a world-only place. The rest are the richer kinds the seeder
/// and the preview fixture use, each with a shape a player can tell apart at
/// 5px radius.
export type GlyphKind =
    | 'battleground' | 'region' | 'outpost' | 'depot' | 'foundry' | 'relay' | 'port';

/// Every kind, in legend order: the two the seeder emits first.
export const GLYPH_KINDS: readonly GlyphKind[] =
    ['battleground', 'region', 'outpost', 'depot', 'foundry', 'relay', 'port'];

/// Human labels for the legend.
export const GLYPH_LABELS: Record<GlyphKind, string> = {
    battleground: 'Battleground — a place you can fight over',
    region: 'Region — world-only, no battle map',
    outpost: 'Outpost',
    depot: 'Depot',
    foundry: 'Foundry',
    relay: 'Relay / waystation',
    port: 'Port',
};

/// Which glyph a POI's `kind` string draws. Unknown kinds fall back on the
/// one distinction that matters most — "can I be sent here" — rather than on
/// a question mark, because a seeder inventing a new kind must not turn its
/// POIs into noise.
export function glyphKindFor(poi: Pick<WorldPoi, 'kind' | 'mapId'>): GlyphKind {
    switch (poi.kind) {
        case 'outpost': return 'outpost';
        case 'depot': return 'depot';
        case 'foundry': return 'foundry';
        case 'relay': case 'waystation': return 'relay';
        case 'port': case 'harbour': case 'harbor': return 'port';
        case 'region': return poi.mapId ? 'battleground' : 'region';
        default: return poi.mapId ? 'battleground' : 'region';
    }
}

/// Unit-radius polygon outlines, as [x, y] pairs, y down. `null` means a
/// circle. A regular polygon's first vertex points up, so a triangle reads as
/// an arrow/tent and a diamond as a compass point.
const POLY: Record<GlyphKind, [number, number][] | null> = {
    battleground: null,
    region: null,
    outpost: regular(3, -Math.PI / 2),
    depot: regular(4, -Math.PI / 4),
    foundry: regular(6, -Math.PI / 2),
    relay: regular(4, -Math.PI / 2),
    port: regular(5, -Math.PI / 2),
};

function regular(n: number, startAngle: number): [number, number][] {
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
        const a = startAngle + (i * 2 * Math.PI) / n;
        pts.push([round(Math.cos(a)), round(Math.sin(a))]);
    }
    return pts;
}

function round(v: number): number { return Math.round(v * 1000) / 1000; }

/// The outline points for a kind, or null for a circle. Exposed for tests
/// and for anyone drawing the glyph with a third renderer.
export function glyphPoints(kind: GlyphKind): readonly [number, number][] | null {
    return POLY[kind];
}

/// A `region` is drawn smaller than everything else: a world-only place is
/// scenery with a name, and the map should say so by giving it less ink.
export function glyphRadiusScale(kind: GlyphKind): number {
    return kind === 'region' ? 0.7 : 1;
}

/// The minimal path surface the glyphs need — a strict subset of `WorldCtx`,
/// restated so this module does not import the whole drawing contract.
export interface GlyphPathCtx {
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    arc(x: number, y: number, r: number, a0: number, a1: number): void;
    closePath(): void;
}

/// Trace (do not fill or stroke) the glyph for `kind` centred on (x, y) with
/// radius `r`. The caller sets styles and calls fill/stroke, so the same
/// trace serves the fill, the outline and the hover ring.
export function traceGlyph(ctx: GlyphPathCtx, kind: GlyphKind, x: number, y: number, r: number): void {
    const pts = POLY[kind];
    ctx.beginPath();
    if (!pts) {
        ctx.arc(x, y, r, 0, Math.PI * 2);
        return;
    }
    ctx.moveTo(x + pts[0][0] * r, y + pts[0][1] * r);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(x + pts[i][0] * r, y + pts[i][1] * r);
    ctx.closePath();
}

/// A claim pennant: a pole with a small triangular flag, planted at the
/// marker's top-right. Traced in one path so one fill paints it.
export function traceClaimFlag(ctx: GlyphPathCtx, x: number, y: number, r: number): void {
    const px = x + r * 0.9, top = y - r * 2.2, base = y - r * 0.6;
    ctx.beginPath();
    ctx.moveTo(px, base);
    ctx.lineTo(px, top);
    ctx.lineTo(px + r * 1.4, top + r * 0.45);
    ctx.lineTo(px, top + r * 0.9);
    ctx.closePath();
}

/// The viewer's commander: a five-point star tucked under the marker's
/// lower-right. "You are here" is the one thing a strategic map must never
/// make the player hunt for.
export function traceCommanderStar(ctx: GlyphPathCtx, x: number, y: number, r: number): void {
    const cx = x + r * 1.3, cy = y + r * 1.3, outer = r * 0.9, inner = r * 0.38;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? outer : inner;
        const sx = cx + Math.cos(a) * rad, sy = cy + Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
}

// ─────────────────────────── SVG for the legend ───────────────────────────

function svgAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/// An inline `<svg>` of the glyph, `size` px square. `fill` and `stroke`
/// are colours the caller has already validated (the palette or a badge).
export function glyphSvg(kind: GlyphKind, fill: string, size = 14, stroke = 'rgba(0,0,0,0.6)'): string {
    const c = size / 2;
    const r = (size / 2 - 1.5) * glyphRadiusScale(kind);
    const pts = POLY[kind];
    const shape = pts
        ? `<polygon points="${pts.map(([x, y]) => `${(c + x * r).toFixed(2)},${(c + y * r).toFixed(2)}`).join(' ')}"/>`
        : `<circle cx="${c}" cy="${c}" r="${r.toFixed(2)}"/>`;
    return `<svg class="wm-glyph" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" ` +
        `aria-hidden="true" fill="${svgAttr(fill)}" stroke="${svgAttr(stroke)}" stroke-width="1">${shape}</svg>`;
}

/// The three marker-state rings for the legend: quiet (none), staging
/// (dashed amber), active (solid red). Drawn around a neutral circle.
export function stateRingSvg(state: 'quiet' | 'staging' | 'active', ringColour: string, size = 18): string {
    const c = size / 2;
    const ring = state === 'quiet' ? '' :
        `<circle cx="${c}" cy="${c}" r="${(c - 1.5).toFixed(2)}" fill="none" stroke="${svgAttr(ringColour)}" ` +
        `stroke-width="1.5"${state === 'staging' ? ' stroke-dasharray="3 2"' : ''}/>`;
    return `<svg class="wm-glyph" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">` +
        `<circle cx="${c}" cy="${c}" r="${(size * 0.22).toFixed(2)}" fill="#8ad2ff"/>${ring}</svg>`;
}

/// The claim pennant and the commander star, for the legend.
export function claimFlagSvg(colour: string, size = 14): string {
    const r = size * 0.28, x = size * 0.3, y = size * 0.75;
    const px = x + r * 0.9, top = y - r * 2.2, base = y - r * 0.6;
    return `<svg class="wm-glyph" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" ` +
        `fill="${svgAttr(colour)}"><polygon points="${px},${base} ${px},${top} ${px + r * 1.4},${top + r * 0.45} ${px},${top + r * 0.9}"/></svg>`;
}

export function commanderStarSvg(colour: string, size = 14): string {
    const c = size / 2, outer = size * 0.42, inner = outer * 0.42;
    const pts: string[] = [];
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? outer : inner;
        pts.push(`${(c + Math.cos(a) * rad).toFixed(2)},${(c + Math.sin(a) * rad).toFixed(2)}`);
    }
    return `<svg class="wm-glyph" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" ` +
        `fill="${svgAttr(colour)}"><polygon points="${pts.join(' ')}"/></svg>`;
}
