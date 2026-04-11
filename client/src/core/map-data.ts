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
    mapDataUrl: string;
    mapSourceUrl: string;
    decals: MapDecalsInfo;
    water: MapWaterInfo;
    hasLuaGaia: boolean;
    /// Relative paths of LuaUI widgets the map ships (e.g. "LuaUI/Widgets/lava_layer.lua").
    widgets: string[];
    // Convenience: world-space dimensions in elmos
    widthElmos: number;
    heightElmos: number;
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
        mapDataUrl: fb.mapDataUrl() ?? '',
        mapSourceUrl: fb.mapSourceUrl() ?? '',
        decals,
        water,
        hasLuaGaia: fb.hasLuaGaia(),
        widgets,
        widthElmos: mapx * squareSize,
        heightElmos: mapy * squareSize,
    };
}
