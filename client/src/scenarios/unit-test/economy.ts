/**
 * Economy bootstrap — at the start of every unit test, spawn one
 * fusion + 5 mexes on the player's team so the test has enough
 * metal/energy to run construction probes, weapon assistance, etc.
 *
 * Metal spots: ZK's `mex_spot_finder.lua` populates `GG.metalSpots`
 * once the gadget has scanned the metalmap. On the flat sandbox map
 * (no authored spots) the list is usually empty, so we fall back to
 * a fixed 5-point cluster near the spawn anchor. Off-spot mexes
 * still produce trickle income — good enough for testing.
 */

import type { TestHarness } from '../../core/test-harness.js';

const FUSION_DEF = 'energyfusion';
const MEX_DEF = 'staticmex';

/** Fixed fallback metal-spot grid centred on `anchorX, anchorZ`.
 *  Spacing matches the mex-spot snap distance so units of any size
 *  can spawn between. */
function fallbackMexSpots(anchorX: number, anchorZ: number): Array<[number, number]> {
    const d = 220;
    return [
        [anchorX,     anchorZ],
        [anchorX + d, anchorZ],
        [anchorX - d, anchorZ],
        [anchorX,     anchorZ + d],
        [anchorX,     anchorZ - d],
    ];
}

export interface EconomyBootstrap {
    fusionId: number;
    mexIds: number[];
    /** Number of mexes that landed on a real metal spot. */
    onSpotCount: number;
}

/** Spawn the standard test economy for `team` near (anchorX, anchorZ).
 *  Returns the spawned IDs so the caller can include them in cleanup. */
export async function spawnEconomy(
    h: TestHarness, team: number, anchorX: number, anchorZ: number,
): Promise<EconomyBootstrap> {
    // Query metal spots first. The Lua side returns a JSON array of
    // {x, z, metal} or `null` if the gadget isn't loaded yet.
    const spotsRaw = await h.lua(`
        if not GG or not GG.metalSpots then return 'null' end
        local r = {}
        for i, s in ipairs(GG.metalSpots) do
            r[#r+1] = string.format('{"x":%d,"z":%d}', s.x or 0, s.z or 0)
        end
        return '[' .. table.concat(r, ',') .. ']'
    `);
    let spots: Array<{ x: number; z: number }> | null = null;
    try { spots = JSON.parse(spotsRaw); } catch { spots = null; }

    let mexPositions: Array<[number, number]>;
    let onSpot = 0;
    if (spots && spots.length >= 5) {
        // Pick the 5 spots nearest the anchor so the test plays in
        // one local area.
        const ranked = spots
            .map((s) => ({ s, d2: (s.x - anchorX) ** 2 + (s.z - anchorZ) ** 2 }))
            .sort((a, b) => a.d2 - b.d2)
            .slice(0, 5)
            .map((r) => [r.s.x, r.s.z] as [number, number]);
        mexPositions = ranked;
        onSpot = 5;
    } else {
        mexPositions = fallbackMexSpots(anchorX, anchorZ);
    }

    // Fusion goes ~400 elmos south of the cluster — out of the way
    // so it doesn't collide with the unit-under-test spawn.
    const fusionOut = await h.spawn(FUSION_DEF, anchorX, anchorZ - 400, team, 1);
    const fusionId = Number(fusionOut.match(/:\s*(\d+)/)?.[1] ?? 0);

    const mexIds: number[] = [];
    for (const [x, z] of mexPositions) {
        const out = await h.spawn(MEX_DEF, x, z, team, 1);
        const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (id) mexIds.push(id);
    }

    return { fusionId, mexIds, onSpotCount: onSpot };
}
