/**
 * TerrainTexture — loads DXT1 tile textures and minimap for terrain.
 * Delegates to terrain.ts loadTerrainTextures().
 *
 * This module exists for backwards compatibility with main.ts imports.
 */

export { loadTerrainTextures as loadTerrainTexture } from './terrain.js';
