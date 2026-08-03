/**
 * aim-origin-probe — beam vs ballistic aim discriminator on the ZK path.
 *
 * Diagnoses "units aim/shoot low" reports by firing two weapon classes at
 * the SAME target from the SAME range and comparing where each lands:
 *
 *   - **BeamLaser** (`turretlaser`, range 460) hits instantly along the aim
 *     ray. If the beam lands low, the defect is purely the **aim point or
 *     aim origin** — there is no trajectory to get wrong.
 *   - **Cannon** (`turretriot`, range 410) solves a ballistic arc. If the
 *     beam is clean but the cannon falls short, the defect is the
 *     **trajectory solve** (or lead/prediction), not the aim point.
 *
 * That single comparison halves the search space before any code is read.
 *
 * Both attackers are static turrets so nothing moves, no lead prediction is
 * involved, and the geometry is fixed for the whole run. The target is an
 * unarmed `staticheavyradar` (the punching bag the unit-test combat category
 * already uses), armored down to near-zero damage intake so it survives long
 * enough for many shots.
 *
 * Dead-team note: same constraint as `duel-attack`. The runner enables cheats
 * and revives every team before `setup` runs; ZK's `game_over.lua` otherwise
 * flags allyteam 1 dead the moment it holds no units and permanently purges
 * anything spawned into it afterwards. A second far-away radar keeps allyteam
 * 1 populated so the purge never arms in the first place.
 */

import type { Scenario } from '../types.js';
import { sleep, currentFrame } from '../types.js';

const CMD_ATTACK = 20;
const FLAT_MAP_CENTER = 8704; // green_flat_x34_v3 is 17408×17408 elmos
/** Both attackers sit exactly this far from the target, so beam and cannon
 *  are compared at identical range (inside both weapons' range: 460 / 410). */
const ENGAGE_RANGE = 300;

interface Probe {
    tgt: number;
    beam: number;
    cannon: number;
}

let _p: Probe = { tgt: 0, beam: 0, cannon: 0 };

/** Parse `k=v` pairs out of a flat `a=1 b=2` string returned from Lua. */
function kv(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of s.matchAll(/([A-Za-z_]\w*)=(-?[\d.]+|nil|yes|no)/g)) out[m[1]] = m[2];
    return out;
}

const scenario: Scenario = {
    name: 'aim-origin-probe',
    description:
        'BeamLaser vs Cannon fired at one target from equal range. Reports aim origin, aim point and impact so a low-aim defect can be attributed to the aim ray or to the trajectory solve.',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,

    async setup(h) {
        await h.setLogging({ combat: true, weapon: true, explosion: true });
        await h.clear();

        const C = FLAT_MAP_CENTER;
        // Spawn the anchor FIRST so allyteam 1 is never empty — see the
        // dead-team note above. Everything else is spawned in one Lua call so
        // no sim frame runs with allyteam 1 unpopulated.
        const out = await h.lua(`
            local C = ${C}
            local anchor = Spring.CreateUnit("staticheavyradar", C + 3000, 0, C + 3000, 0, 1)
            local tgt    = Spring.CreateUnit("staticheavyradar", C, 0, C, 0, 1)
            local beam   = Spring.CreateUnit("turretlaser", C - ${ENGAGE_RANGE}, 0, C, 0, 0)
            local cannon = Spring.CreateUnit("turretriot",  C, 0, C - ${ENGAGE_RANGE}, 0, 0)
            -- Armor the target down so it survives a long observation window
            -- instead of dying to the first few hits.
            if tgt then Spring.SetUnitArmored(tgt, true, 0.0001) end
            return ("tgt=%d beam=%d cannon=%d anchor=%d"):format(tgt or 0, beam or 0, cannon or 0, anchor or 0)
        `);
        const ids = kv(out);
        _p = { tgt: Number(ids.tgt ?? 0), beam: Number(ids.beam ?? 0), cannon: Number(ids.cannon ?? 0) };
        if (!_p.tgt || !_p.beam || !_p.cannon) throw new Error(`spawn failed: ${out}`);

        await h.cameraSnapToGround(C - 120, C - 120, { height: 700, durationMs: 0 });
        await h.order(_p.beam, CMD_ATTACK, [_p.tgt]);
        await h.order(_p.cannon, CMD_ATTACK, [_p.tgt]);
    },

    async run(h) {
        const { tgt, beam, cannon } = _p;
        const startFrame = await currentFrame(h);

        // Geometry snapshot: aim origin (muzzle), aim direction, and the
        // target's own pos/mid/aim triple. Taken after the turrets have had
        // time to slew onto the target so `dir` is the real firing ray and
        // not the idle UpVector.
        await sleep(1500);
        const geom = await h.lua(`
            local function one(tag, id)
                local x, y, z = Spring.GetUnitPosition(id)
                local _, _, _, mx, my, mz, ax, ay, az = Spring.GetUnitPosition(id, true, true)
                local px, py, pz, dx, dy, dz = Spring.GetUnitWeaponVectors(id, 1)
                return ("%s_feetY=%.3f %s_midY=%.3f %s_aimY=%.3f %s_mzlY=%.3f %s_mzlLift=%.3f %s_dirY=%.4f"):
                    format(tag, y, tag, my or y, tag, ay or y, tag, py or y, tag, (py or y) - y, tag, dy or 0)
            end
            local tx, ty, tz = Spring.GetUnitPosition(${tgt})
            local _, _, _, tmx, tmy, tmz, tax, tay, taz = Spring.GetUnitPosition(${tgt}, true, true)
            return one("beam", ${beam}) .. " " .. one("cannon", ${cannon}) ..
                (" tgt_feetY=%.3f tgt_midY=%.3f tgt_aimY=%.3f tgt_h=%.3f tgt_r=%.3f"):
                format(ty, tmy or ty, tay or ty, Spring.GetUnitHeight(${tgt}) or 0, Spring.GetUnitRadius(${tgt}) or 0)
        `);
        const g = kv(geom);

        // Damage attribution. Each attacker is disabled in turn so the HP
        // delta over its window belongs to exactly one weapon class.
        const hpOf = async (): Promise<number> =>
            Number(await h.lua(`return ("%.2f"):format(Spring.GetUnitHealth(${tgt}) or 0)`));

        // 45 = CMD_FIRE_STATE (0 = HoldFire, 2 = FireAtWill).
        const hold = (id: number) => h.lua(`Spring.GiveOrderToUnit(${id}, 45, {0}, 0)`);
        const free = (id: number) => h.lua(`Spring.GiveOrderToUnit(${id}, 45, {2}, 0)`);

        // --- beam only ---
        await hold(cannon);
        await free(beam);
        await h.order(beam, CMD_ATTACK, [tgt]);
        const beamBefore = await hpOf();
        await sleep(4000);
        const beamAfter = await hpOf();
        const beamDamage = beamBefore - beamAfter;

        // --- cannon only ---
        await hold(beam);
        await free(cannon);
        await h.order(cannon, CMD_ATTACK, [tgt]);
        const cannonBefore = await hpOf();
        // Sample the cannon shell mid-flight so a trajectory defect is visible
        // as an arc that peaks and descends short of the target, rather than
        // only as a missing damage tick.
        const traj: string[] = [];
        for (let i = 0; i < 12; i++) {
            const s = await h.lua(`
                local C = ${FLAT_MAP_CENTER}
                local ps = Spring.GetProjectilesInRectangle(C - 600, C - 600, C + 600, C + 600, true, true) or {}
                for _, pid in ipairs(ps) do
                    if Spring.GetProjectileOwnerID(pid) == ${cannon} then
                        local x, y, z = Spring.GetProjectilePosition(pid)
                        if x then return ("%.1f,%.1f,%.1f"):format(x, y, z) end
                    end
                end
                return ""
            `);
            if (s.trim()) traj.push(s.trim());
            await sleep(120);
        }
        await sleep(2500);
        const cannonAfter = await hpOf();
        const cannonDamage = cannonBefore - cannonAfter;

        const endFrame = await currentFrame(h);
        const elapsed = endFrame - startFrame;

        const detail =
            `beam: lift=${g.beam_mzlLift} dirY=${g.beam_dirY} | ` +
            `cannon: lift=${g.cannon_mzlLift} dirY=${g.cannon_dirY} | ` +
            `target: feetY=${g.tgt_feetY} midY=${g.tgt_midY} aimY=${g.tgt_aimY} h=${g.tgt_h}`;

        return [
            {
                name: 'sim advanced',
                ok: elapsed >= 100,
                detail: `${elapsed} frames (expect ≥100)`,
            },
            {
                name: 'target midPos is elevated above its feet',
                // A midPos pinned to the feet makes every midPos-based aim,
                // LOS and collision query point at the ground.
                ok: Number(g.tgt_midY) > Number(g.tgt_feetY) + 1,
                detail: `midY=${g.tgt_midY} feetY=${g.tgt_feetY} (Δ=${(
                    Number(g.tgt_midY) - Number(g.tgt_feetY)
                ).toFixed(3)}, model height ${g.tgt_h})`,
            },
            {
                name: 'BeamLaser hits (aim ray is sound)',
                ok: beamDamage > 0,
                detail: `hp ${beamBefore.toFixed(1)} → ${beamAfter.toFixed(1)} (Δ=${beamDamage.toFixed(2)})`,
            },
            {
                name: 'Cannon hits (trajectory solve is sound)',
                ok: cannonDamage > 0,
                detail: `hp ${cannonBefore.toFixed(1)} → ${cannonAfter.toFixed(
                    1,
                )} (Δ=${cannonDamage.toFixed(2)}); shell samples: ${
                    traj.length ? traj.join(' → ') : 'none seen'
                }`,
            },
            {
                name: 'geometry',
                ok: true,
                detail,
            },
        ];
    },
};

export default scenario;
