/**
 * gp-context.ts — shared mutable seam refs between the game-processor (GP)
 * half and the LuaUI half of the worker.
 *
 * Both halves import this module.  The GP half writes these fields during
 * gpInit / gpConnect / gpShutdown; the LuaUI half reads them (via gpCtx.*)
 * when it needs to reach the connection, renderers, or lighting state.
 *
 * Type-only imports for all class/interface types to keep this module
 * cycle-free.  defaultMapLighting() is the one value import needed to
 * preserve the current gpMapLighting initialiser semantics.
 */

import type { Connection } from './connection.js';
import type { WorkerSelection } from './worker-selection.js';
import type { EntityRenderer } from './entity-renderer.js';
import type { FxLightPool } from './fx-light-pool.js';
import type { ProjectileRenderer } from './projectile-renderer.js';
import type { SceneLighting } from './scene-lighting.js';
import type { AssetLoader } from './asset-loader.js';
import { defaultMapLighting, type MapLighting } from './map-lighting.js';

export const gpCtx = {
    /** was gpConnection (~4900) */
    connection:         null as Connection | null,
    /** was gpSelection (~4840) */
    selection:          null as WorkerSelection | null,
    /** was gpEntityRenderer (~4907) */
    entityRenderer:     null as EntityRenderer | null,
    /** was gpFxLightPool (~4932) */
    fxLightPool:        null as FxLightPool | null,
    /** was gpProjectileRenderer (~4935) */
    projectileRenderer: null as ProjectileRenderer | null,
    /** Shared unit/feature/projectile model-load concurrency pool
     *  (PLAN-lazy-loading.md); used by gpRecomputeBuildTiles to
     *  pre-warm the build menu's buildable defs at idle priority. */
    assetLoader:        null as AssetLoader | null,
    /** was gpSceneLighting (~4889) */
    sceneLighting:      null as SceneLighting | null,
    /** was gpMapLighting (~4895) — keep current initialiser semantics */
    mapLighting:        defaultMapLighting() as MapLighting,
    /** was gpUiGl (~4971) */
    uiGl:               null as WebGL2RenderingContext | null,
    /** was gpLuaUiActive (~4972) */
    luaUiActive:        false,
};
