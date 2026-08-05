/**
 * Unit catalog — queries the live game's UnitDefs and classifies each
 * one by what it can do (movement, combat, build, economy, recon).
 * Used by the unit-test-loop scenario to decide which categories of
 * test apply to each unit-under-test, and to filter out units that
 * don't qualify (ship-only, water-only weapons, etc).
 *
 * Implementation is a single Lua query that walks `UnitDefs` and
 * returns a JSON array. We render JSON-by-hand because the synced
 * Lua state's `json.encode` isn't always available across game
 * versions.
 */

import type { TestHarness } from '../../core/test-harness.js';

export interface UnitClassification {
    /** Numeric defId (1-based, contiguous). */
    defId: number;
    /** Internal name, e.g. "ms_mechs_s1", "fable_colossus". */
    name: string;
    /** Human label, e.g. "Bandit". */
    humanName: string;
    /** True for any unit that can issue Move commands. */
    canMove: boolean;
    /** True for air units (canFly). Useful for picking spawn altitudes. */
    canFly: boolean;
    /** True when the unit has at least one weapon with damage > 0. */
    canShoot: boolean;
    /** True when the unit can build other units (buildOptions non-empty). */
    canBuild: boolean;
    /** True when the unit produces resources passively (mex, fusion, wind). */
    producesResources: boolean;
    /** True when the unit extends LOS or radar beyond its own footprint. */
    extendsRecon: boolean;
    /** True for ground+air. False excludes naval (ship moveDef family). */
    isLandOrAir: boolean;
    /** Top speed in elmos/sec. 0 for structures. */
    speed: number;
    /** Footprint half-extents in elmos (used to pick a free spawn cell). */
    radius: number;
}

/** Run the catalog query once. Returns every UnitDef in the game,
 *  classified. The caller filters down to the unit list for the loop. */
export async function loadCatalog(h: TestHarness): Promise<UnitClassification[]> {
    const lua = `
        local function jsBool(v) return v and 'true' or 'false' end
        local function jsStr(s) return '"' .. (s or ''):gsub('"', '\\\\"'):gsub('\\n',' ') .. '"' end
        local out = {}
        for _, def in pairs(UnitDefs) do
            local canMove = (def.speed or 0) > 0
            local canFly = def.canFly or false
            local canShoot = false
            if def.weapons then
                for _, w in ipairs(def.weapons) do
                    local wd = w and w.weaponDef and WeaponDefs[w.weaponDef]
                    if wd and (wd.damages and (wd.damages[0] or 0) > 0) then
                        canShoot = true
                        break
                    end
                end
            end
            local canBuild = def.buildOptions and #def.buildOptions > 0 or false
            -- Passive income, checked three ways because games declare it
            -- three ways: the legacy def.metalMake / energyMake /
            -- extractsMetal fields, the generator flags, and
            -- customParams.income_* / .ismex (how ZK did it). Metalstorm
            -- sets none of them — its economy is authority-based
            -- (PLAN-metalstorm-economy.md) — so producesResources is
            -- false for every current def. The classification is kept
            -- anyway: it is what a future authority-income category
            -- would key off, and unit-test-loop's selection filter
            -- already includes it, so a producer def is swept the day
            -- one lands.
            local cp = def.customParams or {}
            local incomeM = tonumber(cp.income_metal or 0) or 0
            local incomeE = tonumber(cp.income_energy or 0) or 0
            local isMex = (cp.ismex == '1' or cp.ismex == 1)
            local producesResources = (def.metalMake or 0) > 0
                or (def.energyMake or 0) > 0
                or (def.extractsMetal or 0) > 0
                or (def.windGenerator or 0) > 0
                or (def.tidalGenerator or 0) > 0
                or incomeM > 0 or incomeE > 0 or isMex
            -- Only count active radar/sonar/jammer as recon extension.
            -- Raw LOS (every unit has > 0) would match the whole catalog
            -- and turn the recon test into noise.
            local extendsRecon = (def.radarRadius or 0) > 0
                or (def.jammerRadius or 0) > 0
                or (def.sonarRadius or 0) > 0
            -- Ship filter: naval moveDefs have family == 'ship' OR a
            -- minWaterDepth that requires deep water. The bench map is
            -- dry, so these are excluded from the sweep.
            local moveFamily = def.moveDef and def.moveDef.family or ''
            local needsWater = (def.minWaterDepth or 0) > 0
            local isShip = moveFamily == 'ship' or needsWater
            -- Structures (canMove=false, not flying) — land buildings count
            -- as "isLandOrAir" so radar/economy/turret tests apply.
            local isLandOrAir = canFly or (not isShip)
            local entry =
                  '{"defId":' .. def.id
                .. ',"name":' .. jsStr(def.name)
                .. ',"humanName":' .. jsStr(def.humanName or def.name)
                .. ',"canMove":' .. jsBool(canMove)
                .. ',"canFly":' .. jsBool(canFly)
                .. ',"canShoot":' .. jsBool(canShoot)
                .. ',"canBuild":' .. jsBool(canBuild)
                .. ',"producesResources":' .. jsBool(producesResources)
                .. ',"extendsRecon":' .. jsBool(extendsRecon)
                .. ',"isLandOrAir":' .. jsBool(isLandOrAir)
                .. ',"speed":' .. (def.speed or 0)
                .. ',"radius":' .. (def.radius or 16)
                .. '}'
            out[#out+1] = entry
        end
        return '[' .. table.concat(out, ',') .. ']'
    `;
    const json = await h.lua(lua);
    return JSON.parse(json) as UnitClassification[];
}

/** Pick the list of units to test. If `requestedNames` is non-empty,
 *  filter the catalog to those names (preserves order). Otherwise
 *  return every land/air unit that can move (movement-only v1).
 *  Sorted by name for deterministic iteration. */
export function pickUnits(
    catalog: UnitClassification[],
    requestedNames: string[] | null,
    requireMovement: boolean,
): UnitClassification[] {
    if (requestedNames && requestedNames.length > 0) {
        const want = new Set(requestedNames);
        return catalog
            .filter((u) => want.has(u.name))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    let xs = catalog.filter((u) => u.isLandOrAir);
    if (requireMovement) xs = xs.filter((u) => u.canMove);
    return xs.sort((a, b) => a.name.localeCompare(b.name));
}
