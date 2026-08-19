/**
 * Client-side representation of the MapData FlatBuffer.
 *
 * The game server sends MapData on authentication. It contains:
 *   - Map dimensions (mapx, mapy) and heightmap (uint16 corner heights)
 *   - Tile index + tile count for DXT1 tile compositing
 *   - Typemap + metalmap for gameplay
 *   - Feature type list + feature placements
 *   - Start positions
 *   - HTTP URLs for splat textures, minimap, and concatenated tile data
 *
 * This module flattens the FlatBuffer into a plain object the renderer can use.
 */

import { MapData as FbMapData } from '../protocol/spring-web/map-data.js';
import { MapDecals as FbMapDecals } from '../protocol/spring-web/map-decals.js';
import { MapWater as FbMapWater } from '../protocol/spring-web/map-water.js';

export interface MapFeatureInstance {
    typeIndex: number;
    x: number;
    y: number;
    z: number;
    rotation: number;
    relativeSize: number;
}

/**
 * Definition of a feature type — parallel to `featureTypes[]` (same indices).
 *
 * `modelUrl` is an HTTP URL to a glTF 2.0 binary (`.glb`) converted from
 * the original Spring `.s3o` by the server preprocessing pipeline (modelimporter).
 * `textureUrl` is an HTTP URL to a `.png` converted from the original
 * `.tga`/`.dds`. Either may be empty if the def has no model or asset
 * conversion failed; the renderer falls back to a placeholder in that case.
 */
export interface MapFeatureDefInfo {
    name: string;
    modelUrl: string;
    textureUrl: string;
    footprintX: number;
    footprintZ: number;
    height: number;
    radius: number;
    blocking: boolean;
    reclaimable: boolean;
    metal: number;
    energy: number;
    damage: number;
}

export interface MapStartPosInfo {
    x: number;
    z: number;
}

export interface MapDecalsInfo {
    detailTex: string;
    specularTex: string;
    splatDetailTex: string;
    splatDistrTex: string;
    splatNormal: [string, string, string, string];
    detailNormalTex: string;
    splatScales: [number, number, number, number];
    splatMults: [number, number, number, number];
    /** Recoil `SMF_DETAIL_NORMAL_DIFFUSE_ALPHA` (mapinfo
     *  `resources.splatDetailNormalDiffuseAlpha`). Only meaningful on the
     *  splat-normal branch, where it says the blended detail normals' alpha
     *  channel carries the ground's near-field albedo detail. */
    splatDetailNormalDiffuseAlpha: boolean;
}

export interface MapWaterInfo {
    baseColor: [number, number, number];
    surfaceColor: [number, number, number];
    minColor: [number, number, number];
    surfaceAlpha: number;
    damage: number;
    voidWater: boolean;
}

export interface ParsedMapData {
    mapx: number;
    mapy: number;
    squareSize: number;
    minHeight: number;
    maxHeight: number;
    tilesX: number;
    tilesZ: number;
    numTiles: number;
    tileSize: number;
    startPositions: MapStartPosInfo[];
    featureTypes: string[];
    features: MapFeatureInstance[];
    /// Parallel to `featureTypes` (same indices). Each entry tells the
    /// client how to render and interact with feature instances of that type.
    featureDefs: MapFeatureDefInfo[];
    heightmap: Uint16Array;
    tileindex: Int32Array;
    typemap: Uint8Array;
    metalmap: Uint8Array;
    minimapUrl: string;
    tilesUrl: string;
    /**
     * Map-space ground albedo, or '' when the map delivers its ground colour
     * through the SMT tile dictionary at `tilesUrl`.
     *
     * DEVIATION from Recoil (PLAN-maps.md §2n ruling 1): the tile dictionary
     * terragen writes is a lossy vector quantizer whose 32-elmo seam grid M7d
     * measured at 15.7x the interior gradient. One 2048² map-space texture
     * beats it on error, on seams and on bytes; a map opts in and the server
     * then does not extract `tiles.ktx2` for it at all.
     */
    groundTexUrl: string;
    mapDataUrl: string;
    mapSourceUrl: string;
    decals: MapDecalsInfo;
    water: MapWaterInfo;
    hasLuaGaia: boolean;
    /// `mapinfo.lua → sound.preset` — map-wide reverb preset name.
    /// Empty / `"default"` = no reverb.
    soundPreset: string;
    /// Relative paths of LuaUI widgets the map ships (e.g. "LuaUI/Widgets/lava_layer.lua").
    widgets: string[];
    // Convenience: world-space dimensions in elmos
    widthElmos: number;
    heightElmos: number;
}

/**
 * Fetch map data via HTTP from the lobby server.
 *
 * Fetches metadata.json (lightweight JSON with dimensions, features, decals,
 * water, etc.) plus the binary arrays (heightmap, typemap, metalmap) in
 * parallel. Tileindex is NOT fetched here — terrain.ts fetches it via its
 * own cache path.
 *
 * This replaces the previous approach of sending a 2+ MB MapData FlatBuffer
 * over WebRTC data channels, which exceeded the 256KB SCTP message size limit.
 */
export async function fetchMapDataHttp(mapId: string): Promise<ParsedMapData> {
    // Relative URL: resolves against the page origin so dev (Vite plugin
    // at :8012) and prod (nginx/CDN fronting the SPA) both work without
    // per-environment configuration. The lobby process no longer serves
    // `/api/maps/data/*` after commit 78027e4004.
    const base = `/api/maps/data/${mapId}`;

    const [metaResp, hmBuf, tmBuf, mmBuf] = await Promise.all([
        fetch(`${base}/metadata.json`).then(r => {
            if (!r.ok) throw new Error(`metadata.json: ${r.status}`);
            return r.json();
        }),
        fetch(`${base}/heightmap.bin`).then(r => {
            if (!r.ok) throw new Error(`heightmap.bin: ${r.status}`);
            return r.arrayBuffer();
        }),
        fetch(`${base}/typemap.bin`).then(r => {
            if (!r.ok) throw new Error(`typemap.bin: ${r.status}`);
            return r.arrayBuffer();
        }),
        fetch(`${base}/metalmap.bin`).then(r => {
            if (!r.ok) throw new Error(`metalmap.bin: ${r.status}`);
            return r.arrayBuffer();
        }),
    ]);

    const meta = metaResp;
    const mapx = meta.mapx ?? 0;
    const mapy = meta.mapy ?? 0;
    const squareSize = meta.squareSize ?? 8;

    const startPositions: MapStartPosInfo[] = (meta.startPositions ?? []).map(
        (sp: { x: number; z: number }) => ({ x: sp.x, z: sp.z })
    );

    const featureTypes: string[] = meta.featureTypes ?? [];

    const features: MapFeatureInstance[] = (meta.features ?? []).map(
        (f: { typeIndex: number; x: number; y: number; z: number; rotation: number; relativeSize: number }) => ({
            typeIndex: f.typeIndex, x: f.x, y: f.y, z: f.z,
            rotation: f.rotation, relativeSize: f.relativeSize,
        })
    );

    const featureDefs: MapFeatureDefInfo[] = (meta.featureDefs ?? []).map(
        (d: {
            name: string; modelUrl: string; textureUrl: string;
            footprintX: number; footprintZ: number;
            height: number; radius: number;
            blocking: boolean; reclaimable: boolean;
            metal: number; energy: number; damage: number;
        }) => ({
            name: d.name ?? '', modelUrl: d.modelUrl ?? '', textureUrl: d.textureUrl ?? '',
            footprintX: d.footprintX ?? 0, footprintZ: d.footprintZ ?? 0,
            height: d.height ?? 0, radius: d.radius ?? 0,
            blocking: d.blocking ?? true, reclaimable: d.reclaimable ?? false,
            metal: d.metal ?? 0, energy: d.energy ?? 0, damage: d.damage ?? 0,
        })
    );

    const md = meta.decals ?? {};
    const decals: MapDecalsInfo = {
        detailTex:       md.detailTex ?? '',
        specularTex:     md.specularTex ?? '',
        splatDetailTex:  md.splatDetailTex ?? '',
        splatDistrTex:   md.splatDistrTex ?? '',
        splatNormal: [
            md.splatNormal?.[0] ?? '',
            md.splatNormal?.[1] ?? '',
            md.splatNormal?.[2] ?? '',
            md.splatNormal?.[3] ?? '',
        ],
        detailNormalTex: md.detailNormalTex ?? '',
        splatScales: [
            md.splatScales?.[0] ?? 0.02,
            md.splatScales?.[1] ?? 0.02,
            md.splatScales?.[2] ?? 0.02,
            md.splatScales?.[3] ?? 0.02,
        ],
        splatMults: [
            md.splatMults?.[0] ?? 1.0,
            md.splatMults?.[1] ?? 1.0,
            md.splatMults?.[2] ?? 1.0,
            md.splatMults?.[3] ?? 1.0,
        ],
        splatDetailNormalDiffuseAlpha: !!md.splatDetailNormalDiffuseAlpha,
    };

    const mw = meta.water ?? {};
    const water: MapWaterInfo = {
        baseColor: [
            mw.baseColor?.[0] ?? 0,
            mw.baseColor?.[1] ?? 0.4,
            mw.baseColor?.[2] ?? 0.7,
        ],
        surfaceColor: [
            mw.surfaceColor?.[0] ?? 0.75,
            mw.surfaceColor?.[1] ?? 0.8,
            mw.surfaceColor?.[2] ?? 0.85,
        ],
        minColor: [
            mw.minColor?.[0] ?? 0,
            mw.minColor?.[1] ?? 0.2,
            mw.minColor?.[2] ?? 0.4,
        ],
        surfaceAlpha: mw.surfaceAlpha ?? 0.55,
        damage: mw.damage ?? 0,
        voidWater: mw.voidWater ?? false,
    };

    const widgets: string[] = meta.widgets ?? [];

    return {
        mapx, mapy, squareSize,
        minHeight: meta.minHeight ?? 0,
        maxHeight: meta.maxHeight ?? 0,
        tilesX: meta.tilesX ?? 0,
        tilesZ: meta.tilesZ ?? 0,
        numTiles: meta.numTiles ?? 0,
        tileSize: meta.tileSize ?? 32,
        startPositions,
        featureTypes,
        features,
        featureDefs,
        heightmap: new Uint16Array(hmBuf),
        tileindex: new Int32Array(0), // terrain.ts fetches tileindex.bin separately
        typemap: new Uint8Array(tmBuf),
        metalmap: new Uint8Array(mmBuf),
        minimapUrl: meta.minimapUrl ?? '',
        tilesUrl: meta.tilesUrl ?? '',
        groundTexUrl: meta.groundTexUrl ?? '',
        mapDataUrl: meta.mapDataUrl ?? '',
        mapSourceUrl: meta.mapSourceUrl ?? '',
        decals,
        water,
        hasLuaGaia: meta.hasLuaGaia ?? false,
        soundPreset: meta.soundPreset ?? '',
        widgets,
        widthElmos: mapx * squareSize,
        heightElmos: mapy * squareSize,
    };
}

/** Flatten a FlatBuffer MapData table into a plain object. */
export function parseMapData(fb: FbMapData): ParsedMapData {
    // Copy the typed arrays so they survive past the FlatBuffer's lifetime.
    // (FlatBuffer-backed arrays share memory with the underlying bytes.)
    const hmSrc = fb.heightmapArray();
    const tiSrc = fb.tileindexArray();
    const tmSrc = fb.typemapArray();
    const mmSrc = fb.metalmapArray();
    const heightmap = hmSrc ? new Uint16Array(hmSrc) : new Uint16Array();
    const tileindex = tiSrc ? new Int32Array(tiSrc) : new Int32Array();
    const typemap   = tmSrc ? new Uint8Array(tmSrc) : new Uint8Array();
    const metalmap  = mmSrc ? new Uint8Array(mmSrc) : new Uint8Array();

    const startPositions: MapStartPosInfo[] = [];
    for (let i = 0; i < fb.startPositionsLength(); i++) {
        const sp = fb.startPositions(i);
        if (sp) startPositions.push({ x: sp.x(), z: sp.z() });
    }

    const featureTypes: string[] = [];
    for (let i = 0; i < fb.featureTypesLength(); i++) {
        featureTypes.push(fb.featureTypes(i) ?? '');
    }

    const features: MapFeatureInstance[] = [];
    for (let i = 0; i < fb.featuresLength(); i++) {
        const f = fb.features(i);
        if (!f) continue;
        features.push({
            typeIndex: f.typeIndex(),
            x: f.x(), y: f.y(), z: f.z(),
            rotation: f.rotation(),
            relativeSize: f.relativeSize(),
        });
    }

    const featureDefs: MapFeatureDefInfo[] = [];
    for (let i = 0; i < fb.featureDefsLength(); i++) {
        const d = fb.featureDefs(i);
        if (!d) continue;
        featureDefs.push({
            name: d.name() ?? '',
            modelUrl: d.modelUrl() ?? '',
            textureUrl: d.textureUrl() ?? '',
            footprintX: d.footprintX(),
            footprintZ: d.footprintZ(),
            height: d.height(),
            radius: d.radius(),
            blocking: d.blocking(),
            reclaimable: d.reclaimable(),
            metal: d.metal(),
            energy: d.energy(),
            damage: d.damage(),
        });
    }

    const fbWater = fb.water(new FbMapWater());
    const water: MapWaterInfo = {
        baseColor: [
            fbWater?.baseColor(0) ?? 0,
            fbWater?.baseColor(1) ?? 0.4,
            fbWater?.baseColor(2) ?? 0.7,
        ],
        surfaceColor: [
            fbWater?.surfaceColor(0) ?? 0.75,
            fbWater?.surfaceColor(1) ?? 0.8,
            fbWater?.surfaceColor(2) ?? 0.85,
        ],
        minColor: [
            fbWater?.minColor(0) ?? 0,
            fbWater?.minColor(1) ?? 0.2,
            fbWater?.minColor(2) ?? 0.4,
        ],
        surfaceAlpha: fbWater?.surfaceAlpha() ?? 0.55,
        damage: fbWater?.damage() ?? 0,
        voidWater: fbWater?.voidWater() ?? false,
    };

    const fbDecals = fb.decals(new FbMapDecals());
    const decals: MapDecalsInfo = {
        detailTex:       fbDecals?.detailTex() ?? '',
        specularTex:     fbDecals?.specularTex() ?? '',
        splatDetailTex:  fbDecals?.splatDetailTex() ?? '',
        splatDistrTex:   fbDecals?.splatDistrTex() ?? '',
        splatNormal: [
            fbDecals?.splatNormal0() ?? '',
            fbDecals?.splatNormal1() ?? '',
            fbDecals?.splatNormal2() ?? '',
            fbDecals?.splatNormal3() ?? '',
        ],
        detailNormalTex: fbDecals?.detailNormalTex() ?? '',
        splatScales: [
            fbDecals?.splatScales(0) ?? 0.02,
            fbDecals?.splatScales(1) ?? 0.02,
            fbDecals?.splatScales(2) ?? 0.02,
            fbDecals?.splatScales(3) ?? 0.02,
        ],
        splatMults: [
            fbDecals?.splatMults(0) ?? 1.0,
            fbDecals?.splatMults(1) ?? 1.0,
            fbDecals?.splatMults(2) ?? 1.0,
            fbDecals?.splatMults(3) ?? 1.0,
        ],
        splatDetailNormalDiffuseAlpha:
            fbDecals?.splatDetailNormalDiffuseAlpha() ?? false,
    };

    const mapx = fb.mapx();
    const mapy = fb.mapy();
    const squareSize = fb.squareSize() || 8;

    const widgets: string[] = [];
    for (let i = 0; i < fb.widgetsLength(); i++) {
        const w = fb.widgets(i);
        if (w) widgets.push(w);
    }

    return {
        mapx, mapy, squareSize,
        minHeight: fb.minHeight(),
        maxHeight: fb.maxHeight(),
        tilesX: fb.tilesX(),
        tilesZ: fb.tilesZ(),
        numTiles: fb.numTiles(),
        tileSize: fb.tileSize() || 32,
        startPositions,
        featureTypes,
        features,
        featureDefs,
        heightmap, tileindex, typemap, metalmap,
        minimapUrl: fb.minimapUrl() ?? '',
        tilesUrl: fb.tilesUrl() ?? '',
        groundTexUrl: fb.groundTexUrl() ?? '',
        mapDataUrl: fb.mapDataUrl() ?? '',
        mapSourceUrl: fb.mapSourceUrl() ?? '',
        decals,
        water,
        hasLuaGaia: fb.hasLuaGaia(),
        // The FlatBuffer transport doesn't carry soundPreset yet; only
        // the HTTP metadata.json path does. Callers using parseMapData
        // (sim-side authoritative flow) won't get reverb. That's fine —
        // every modern code path goes through fetchMapDataHttp.
        soundPreset: '',
        widgets,
        widthElmos: mapx * squareSize,
        heightElmos: mapy * squareSize,
    };
}
