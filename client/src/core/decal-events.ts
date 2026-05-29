/**
 * DecalEvents — parses the server's per-tick ground-decal batch
 * (envelope byte 0x08).
 *
 * Two decal kinds share one frame: scorch scars (from weapon
 * explosions) and vehicle track segments. The server derives both
 * authoritatively (see rts/Server/ServerDecalHandler.cpp +
 * DecalEventCollector.h) and broadcasts them write-once — no delta
 * compression, no per-decal updates.
 *
 * Wire format, little-endian (matches Protocol::BuildDecalBatch on
 * the server):
 *
 *   Header:
 *     u8  envelope = 0x08   (already stripped by the dispatcher)
 *     u32 frame
 *
 *   Scars:
 *     u16 scarCount
 *     scarCount × {
 *       f32 x, y, z          // y is unsnapped; client snaps to heightmap
 *       f32 radius           // half-extent in elmos
 *       f32 ttl              // lifetime, seconds
 *       f32 alpha            // initial opacity 0..1
 *       f32 glow             // additive glow 0..1
 *       f32 glowTtl          // glow lifetime, seconds
 *       u8  r, g, b, a       // colour tint, 0..255 (0.5 grey = no change)
 *     }
 *
 *   Tracks:
 *     u16 trackCount
 *     trackCount × {
 *       u32 unitId
 *       f32 x, y, z          // segment end (current tracked pos)
 *       f32 dirX, dirZ       // normalised XZ travel vector
 *       f32 width
 *       f32 strength         // fade-time multiplier
 *       u16 trackTypeId      // index into the client track atlas
 *       u8  team
 *     }
 */

export interface ScarEvent {
    x: number;
    y: number;
    z: number;
    radius: number;
    ttl: number;
    alpha: number;
    glow: number;
    glowTtl: number;
    /** Tint, 0..1 per channel. 0.5 grey = no colour change (Recoil scale). */
    r: number;
    g: number;
    b: number;
    a: number;
}

export interface TrackSegmentEvent {
    unitId: number;
    x: number;
    y: number;
    z: number;
    dirX: number;
    dirZ: number;
    width: number;
    strength: number;
    trackTypeId: number;
    team: number;
}

export interface DecalSnapshot {
    frame: number;
    scars: ScarEvent[];
    tracks: TrackSegmentEvent[];
}

const SCAR_BYTES = 3 * 4 + 5 * 4 + 4; // xyz + radius/ttl/alpha/glow/glowTtl + rgba
const TRACK_BYTES = 4 + 3 * 4 + 2 * 4 + 2 * 4 + 2 + 1; // unitId + xyz + dir + w/str + typeId + team

export function parseDecals(input: Uint8Array): DecalSnapshot | null {
    if (input.byteLength < 6) return null;

    // Align into a fresh buffer so DataView reads at any offset are safe.
    const data = new Uint8Array(input.length);
    data.set(input);
    const view = new DataView(data.buffer, 0, data.byteLength);

    const frame = view.getUint32(0, true);
    let offset = 4;

    if (offset + 2 > data.byteLength) return null;
    const scarCount = view.getUint16(offset, true); offset += 2;

    const scars: ScarEvent[] = new Array(scarCount);
    for (let i = 0; i < scarCount; i++) {
        if (offset + SCAR_BYTES > data.byteLength) return null;
        const x = view.getFloat32(offset, true); offset += 4;
        const y = view.getFloat32(offset, true); offset += 4;
        const z = view.getFloat32(offset, true); offset += 4;
        const radius = view.getFloat32(offset, true); offset += 4;
        const ttl = view.getFloat32(offset, true); offset += 4;
        const alpha = view.getFloat32(offset, true); offset += 4;
        const glow = view.getFloat32(offset, true); offset += 4;
        const glowTtl = view.getFloat32(offset, true); offset += 4;
        const r = view.getUint8(offset) / 255; offset += 1;
        const g = view.getUint8(offset) / 255; offset += 1;
        const b = view.getUint8(offset) / 255; offset += 1;
        const a = view.getUint8(offset) / 255; offset += 1;
        scars[i] = { x, y, z, radius, ttl, alpha, glow, glowTtl, r, g, b, a };
    }

    if (offset + 2 > data.byteLength) return null;
    const trackCount = view.getUint16(offset, true); offset += 2;

    const tracks: TrackSegmentEvent[] = new Array(trackCount);
    for (let i = 0; i < trackCount; i++) {
        if (offset + TRACK_BYTES > data.byteLength) return null;
        const unitId = view.getUint32(offset, true); offset += 4;
        const x = view.getFloat32(offset, true); offset += 4;
        const y = view.getFloat32(offset, true); offset += 4;
        const z = view.getFloat32(offset, true); offset += 4;
        const dirX = view.getFloat32(offset, true); offset += 4;
        const dirZ = view.getFloat32(offset, true); offset += 4;
        const width = view.getFloat32(offset, true); offset += 4;
        const strength = view.getFloat32(offset, true); offset += 4;
        const trackTypeId = view.getUint16(offset, true); offset += 2;
        const team = view.getUint8(offset); offset += 1;
        tracks[i] = { unitId, x, y, z, dirX, dirZ, width, strength, trackTypeId, team };
    }

    return { frame, scars, tracks };
}
