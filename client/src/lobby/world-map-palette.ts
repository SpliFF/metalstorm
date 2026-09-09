/**
 * world-map-palette.ts — faction colours for the World screen.
 *
 * Two problems, one module:
 *
 *  1. A faction may have no usable colour (a lobby built before W7, a badge
 *     that failed `#rrggbb` validation, a faction dissolved between the two
 *     halves of one response). The map still has to tell its holdings apart
 *     from every other faction's, so it needs a colour it can DERIVE from the
 *     id — the same colour on every client, on every reload, with no state.
 *
 *  2. Faction-chosen colours are chosen by players, and two players choosing
 *     "red" is the ordinary case. A "safe colours" layer lets the map ignore
 *     the badges entirely and paint from a palette built to stay distinct
 *     for the ~8% of players with a colour-vision deficiency.
 *
 * The palette is Okabe–Ito (the 7 chromatic entries, black dropped: this map
 * is dark) followed by three of Paul Tol's qualitative colours that stay
 * separable from the first seven under deuteranopia and protanopia. Ten
 * slots. A world with more than ten factions wraps — and at that point no
 * palette can save it, which is why the halo AND the glyph AND the name all
 * carry the faction, not the hue alone.
 */

/// Colour-blind-safe qualitative palette, `#rrggbb`, ordered so the first
/// few assignments are the most separable pairs.
export const SAFE_PALETTE: readonly string[] = [
    '#e69f00', // orange
    '#56b4e9', // sky blue
    '#009e73', // bluish green
    '#f0e442', // yellow
    '#0072b2', // blue
    '#d55e00', // vermillion
    '#cc79a7', // reddish purple
    '#ee3377', // magenta (Tol vibrant)
    '#bbbbbb', // grey (Tol)
    '#aa4499', // purple (Tol muted)
];

/// FNV-1a over the UTF-16 code units. Not cryptographic, and does not need to
/// be: it only has to give the same slot for the same id on every machine.
export function hashId(id: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/// The colour a faction id hashes to, on its own. Stable per id forever, but
/// two ids can share a slot — use `assignFactionColours` when the set of
/// factions on screen is known, which is always, on the map.
export function paletteColour(id: string, palette: readonly string[] = SAFE_PALETTE): string {
    return palette[hashId(id) % palette.length];
}

/**
 * Give every id in `ids` a palette colour, distinct while the palette lasts.
 *
 * Deterministic: the ids are visited in sorted order and each takes its hash
 * slot or, if taken, the next free one (linear probe). Adding a faction to
 * the world can therefore only change the colour of a faction whose hash
 * slot the newcomer sorts ahead of AND collides with — rare, and the price
 * of never painting two factions the same hue on one map. Past the palette's
 * length the probe wraps and colours repeat.
 */
export function assignFactionColours(
    ids: Iterable<string>, palette: readonly string[] = SAFE_PALETTE,
): Record<string, string> {
    const sorted = Array.from(new Set(ids)).sort();
    const taken = new Array<boolean>(palette.length).fill(false);
    const out: Record<string, string> = {};
    let assigned = 0;
    for (const id of sorted) {
        let slot = hashId(id) % palette.length;
        if (assigned < palette.length) {
            while (taken[slot]) slot = (slot + 1) % palette.length;
            taken[slot] = true;
            assigned++;
        }
        out[id] = palette[slot];
    }
    return out;
}

/// `#rrggbb` → [r, g, b], or null for anything else. The map only ever
/// receives validated six-digit hex (parseWorldGraph drops the rest), so a
/// null here is a programming error upstream rather than bad data.
export function hexToRgb(hex: string): [number, number, number] | null {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/// `#rrggbb` + alpha → `rgba(r, g, b, a)`. For halos and rings: a canvas has
/// no opacity property on a fillStyle, so a translucent faction colour has to
/// be spelt out.
export function withAlpha(hex: string, alpha: number): string {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const a = Math.max(0, Math.min(1, alpha));
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/// WCAG relative luminance, for picking text over a swatch.
export function relativeLuminance(hex: string): number {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    const lin = (c: number): number => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/// Black or white, whichever reads on `hex`. The chip's owner badge uses it:
/// a yellow faction with white text on it is a badge nobody can read.
export function contrastText(hex: string): '#000000' | '#ffffff' {
    return relativeLuminance(hex) > 0.4 ? '#000000' : '#ffffff';
}
