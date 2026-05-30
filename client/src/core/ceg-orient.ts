/**
 * Per-particle orientation modes (Phase T) — a dependency-free leaf so
 * both the CEG runtime (which composes the quad matrix) and the CEG
 * translator (which tags spawns) can share them without the translator's
 * unit tests pulling in the runtime's Babylon/config module graph.
 *
 * Decides how `buildClassBuffers` orients each particle quad:
 *   - BILLBOARD (default) — camera-facing sprite, the original path.
 *   - GROUND    — flat quad on the XZ plane, normal +Y. Ground-conformed
 *     explosion flashes (Recoil's `CStandardGroundFlash`) and wake rings
 *     (`CWakeProjectile`) use this so they lie *on* the terrain instead
 *     of floating as camera billboards.
 *   - STRETCH   — quad whose long axis aligns with the particle's
 *     velocity, cylindrically billboarded around it. Tracers
 *     (`CTracerProjectile`) and explosion spikes (`CExploSpikeProjectile`)
 *     use this so they read as streaks, not blobs.
 */
export const ORIENT_BILLBOARD = 0;
export const ORIENT_GROUND = 1;
export const ORIENT_STRETCH = 2;
