/**
 * weapon-showcase — slow-motion tour of every weapon archetype the
 * engine currently renders, in a single deterministic run.
 *
 * For each entry in `WEAPONS` the scenario spawns a shooter + a target
 * on the flat map, frames the camera close on the pair, orders the
 * shooter to attack, dwells for `dwellMs` (long enough to see at least
 * one full reload at 0.25× sim speed), then tears the pair down and
 * advances to the next archetype. The target stays invulnerable + on
 * hold-fire / hold-position so the engagement plays out cleanly even
 * if the shooter has to chase aim. The sim runs at 0.25× by default
 * — the camera zooms in close enough that projectile travel, trail
 * puffs and impact CEGs are clearly readable.
 *
 * Coverage (ZK names in parens):
 *   - LaserCannon       (shieldraid → Bandit)
 *   - BeamLaser         (cloakaa → Gremlin, fires at flying drone)
 *   - Cannon            (staticheavyarty → Big Bertha)
 *   - StarburstLauncher (vehheavyarty Impaler — ballistic missile rover)
 *   - StarburstLauncher (staticnuke → Trinity)        ← nuclear missile
 *   - MissileLauncher   (bomberstrike → Magpie)
 *   - LightningCannon   (shieldfelon → Felon)
 *   - DGun              (striderantiheavy → Ultimatum)
 *   - AircraftBomb      (bomberstrike — second weapon)
 *   - Flak (Cannon)     (turretaaflak → Thresher → flying drone)
 *   - Ground-to-air SAM (hoveraa → Flail → flying drone)
 *   - Air-to-air        (planefighter → Swift, MoveCtrl warped airborne)
 *   - Naval / torpedo   (PLACEHOLDER — current test map has no water)
 *
 * URL params (all optional):
 *   ?scenario=weapon-showcase
 *   ?scenario=weapon-showcase&only=nuke         run just the named entry
 *   ?scenario=weapon-showcase&speed=0.1         sim-speed multiplier
 *   ?scenario=weapon-showcase&dwellMs=20000     ms per archetype
 *   ?scenario=weapon-showcase&fitAll=1          frame every pair at once
 *
 * After boot, normal `+`/`-`/`Pause` hotkeys still work — the scenario
 * just sets an initial speed. `T` toggles tracking on/off if you want
 * to break free of the auto-advance.
 */

import type { Scenario } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import { sleep } from '../types.js';

const CMD_ATTACK       = 20;
const CMD_MOVE_STATE   = 50;
const CMD_FIRE_STATE   = 45;
const CMD_MANUALFIRE   = 105;

// Map metrics: green_flat_x34_v3 is 17408×17408 elmos, completely flat.
const MAP_CENTER = 8704;

// Default sim-speed and per-pair dwell. 0.25× makes projectile travel
// readable; 18 s of wall time = 4.5 s of sim time, comfortably more
// than a reload for every weapon listed below except the nuke
// (which the scenario stockpiles explicitly).
const DEFAULT_SPEED = 0.25;
const DEFAULT_DWELL_MS = 18_000;

interface WeaponEntry {
    /// Slug — `?only=<key>` selects this entry alone.
    key: string;
    /// Single-line description, logged to the console when the entry
    /// becomes active.
    title: string;
    /// Unit def name of the shooter.
    shooter: string;
    /// Unit def name of the target. Always spawned on team 1.
    target: string;
    /// Separation between shooter (west) and target (east) in elmos.
    /// Tuned per-weapon so the target sits comfortably inside range.
    distance: number;
    /// `true` → keep the target on the ground but hold-fire (still
    /// invulnerable). `'flying'` → MoveCtrl-warp the target to a
    /// fixed altitude so flak / SAM / air-to-air have something
    /// airborne to engage.
    targetMode: 'ground' | 'flying';
    /// Sim-frame altitude for flying targets. Ignored when the
    /// targetMode is 'ground'.
    targetAlt?: number;
    /// `true` when the shooter itself needs to be airborne — used for
    /// the air-to-air entry. We MoveCtrl-warp it after spawn so the
    /// engine's stuck-on-ground takeoff path doesn't gate the test.
    shooterFlying?: boolean;
    /// `true` for stockpile-gated weapons (nukes). The scenario
    /// pre-stockpiles via the `stockpile` server verb and orders an
    /// attack-ground at the target instead of a unit-attack.
    stockpile?: boolean;
    /// `true` for manual-fire / DGun weapons. Switches the order
    /// verb to `CMD_MANUALFIRE` against the target position.
    manualFire?: boolean;
    /// Extra Lua to run before the attack order — e.g. raising
    /// stockpile count, force-acquiring the target. Receives the
    /// shooter+target IDs as substitution placeholders `$SID` / `$TID`.
    extraSetup?: string;
    /// Per-entry camera padding override. `cameraFitUnits` defaults to
    /// 1.4; this scenario default is `DEFAULT_PADDING` (2.2 — wide
    /// enough that both units sit comfortably inside the frame with
    /// projectile travel between them). Tall buildings (Big Bertha,
    /// staticnuke) need 2.8–3.2 so the silhouette doesn't clip the top
    /// of the viewport; very-close pairs (DGun at 350 elmos) can drop
    /// to 1.8 to keep the action readable.
    padding?: number;
    /// Camera pitch in degrees. Defaults to `DEFAULT_PITCH` (45° — a
    /// half-bird's-eye that keeps both ground silhouettes and arcing
    /// projectiles in view). Tall units want a steeper pitch (55°+) so
    /// the camera looks down on them rather than at their flank;
    /// long-arc ballistic weapons want a shallower pitch (30°–35°) to
    /// show the apex.
    pitchDeg?: number;
    /// Optional camera focus point. When set, the camera snaps to this
    /// ground point at `cameraHeight` instead of fitting the units.
    /// Used by nuke / long-range weapons whose projectile arc dwarfs
    /// the shooter+target footprint (a unit-fit would lose the arc).
    cameraFocus?: { x: number; z: number };
    /// Camera height for `cameraFocus`-mode entries. In elmos above the
    /// ground point.
    cameraHeight?: number;
    /// `true` to disable the tracking camera for this entry. Defaults
    /// to `false` (tracking on, follows the selected shooter). Disable
    /// when the projectile arcs far away from the shooter (nukes, long
    /// SAMs) so the camera stays fixed and the arc plays through the
    /// frame instead of being chased.
    noTracking?: boolean;
    /// Hold the (mobile) shooter in place so it fires from its spawn
    /// position instead of advancing to optimal range. Needed for mobile
    /// artillery (Impaler) — a ground-fit camera assumes the shooter
    /// stays put. Bombers/aircraft must NOT set this (they need to move).
    shooterHoldPos?: boolean;
    /// Long-arc weapons (nuke, artillery, starburst) launch a projectile
    /// that travels far from the shooter and lands off-frame. When set,
    /// the camera pans to the impact point `delayMs` after the fire order
    /// so the hit itself is on screen; the next entry restores the camera.
    /// `delayMs` should roughly match the projectile's flight time at the
    /// active sim speed.
    impactCam?: { delayMs: number; height: number; pitchDeg?: number };
}

/// Default per-entry padding when an entry doesn't override it.
/// Wider than `cameraFitUnits`'s 1.4 so both silhouettes get visual
/// breathing room and projectile mid-flight isn't cropped against the
/// edge of the viewport.
const DEFAULT_PADDING = 2.2;

/// Default camera pitch — a 45° half-bird's-eye reads both the ground
/// engagement and any vertical arc cleanly. Shallower angles cut into
/// tall buildings; steeper angles flatten the projectile travel.
const DEFAULT_PITCH = 45;

const WEAPONS: WeaponEntry[] = [
    {
        key: 'lasercannon',
        title: 'LaserCannon — moving bolt with cap glow (shieldraid → Bandit)',
        shooter: 'shieldraid', target: 'damagesink',
        distance: 200, targetMode: 'ground',
        // Both units small; default framing works well. Slightly looser
        // padding so the laser bolts mid-flight stay clear of the edges.
        padding: 2.2, pitchDeg: 38,
    },
    {
        key: 'beamlaser',
        title: 'BeamLaser — hit-scan beam (cloakaa → Gremlin, vs airborne drone)',
        shooter: 'cloakaa', target: 'fakeunit_aatarget',
        distance: 400, targetMode: 'flying', targetAlt: 220,
        padding: 2.4, pitchDeg: 30,
    },
    {
        key: 'cannon',
        title: 'Cannon — ballistic plasma (staticheavyarty → Big Bertha)',
        shooter: 'staticheavyarty', target: 'damagesink',
        distance: 1200, targetMode: 'ground',
        // Big Bertha is a tall building (~120 elmos) — wider padding +
        // steeper pitch so its silhouette doesn't fill the frame and the
        // projectile arc has room to play out toward the target.
        padding: 3.0, pitchDeg: 50,
        noTracking: true,
        // Plasma shell arcs 1200 elmos to the target — pan to the impact
        // once it's mid-descent so the hit is on screen.
        impactCam: { delayMs: 5000, height: 650, pitchDeg: 48 },
    },
    {
        key: 'starburst',
        title: 'StarburstLauncher — ballistic missile (vehheavyarty Impaler)',
        // empmissile ("Shockley") was a one-shot EMP *missile* unit — it
        // rendered as a bare missile sitting on the ground with nothing to
        // launch it. Impaler is a real artillery rover that fires a
        // StarburstLauncher missile and stays put to reload.
        shooter: 'vehheavyarty', target: 'damagesink',
        distance: 800, targetMode: 'ground',
        shooterHoldPos: true,
        // Focus the camera mid-arc with extra height so the missile
        // climb + descent is visible end-to-end. Tracking off because
        // the projectile leaves the shooter quickly.
        cameraFocus: { x: MAP_CENTER, z: MAP_CENTER },
        cameraHeight: 1400, pitchDeg: 40,
        noTracking: true,
        impactCam: { delayMs: 5500, height: 700, pitchDeg: 45 },
    },
    {
        key: 'nuke',
        title: 'StarburstLauncher (nuke) — Trinity ICBM',
        shooter: 'staticnuke', target: 'damagesink',
        distance: 2000, targetMode: 'ground',
        stockpile: true,
        // Nuke needs the widest camera — it climbs ~1800 elmos and
        // travels 2000 horizontally. Stand the camera back at 2500
        // height with a 35° pitch so the ascent, turn, and descent
        // are all readable.
        cameraFocus: { x: MAP_CENTER, z: MAP_CENTER },
        cameraHeight: 2500, pitchDeg: 35,
        noTracking: true,
        // The Trinity has a long flight — pan to the impact late so the
        // detonation (and its huge CEG) fills the frame.
        impactCam: { delayMs: 11000, height: 1400, pitchDeg: 45 },
    },
    {
        key: 'missile',
        title: 'MissileLauncher — guided rocket (bomberstrike → Magpie heavy missiles)',
        shooter: 'bomberstrike', target: 'damagesink',
        distance: 500, targetMode: 'ground',
        shooterFlying: true,
        padding: 2.6, pitchDeg: 35,
    },
    {
        key: 'lightning',
        title: 'LightningCannon — bolt arc (shieldfelon → Felon)',
        shooter: 'shieldfelon', target: 'damagesink',
        distance: 300, targetMode: 'ground',
        padding: 2.4, pitchDeg: 40,
    },
    {
        key: 'dgun',
        title: 'DGun — Disintegrator fireball (striderantiheavy → Ultimatum)',
        shooter: 'striderantiheavy', target: 'damagesink',
        distance: 350, targetMode: 'ground',
        manualFire: true,
        // Tighter framing — the fireball is short-range and dramatic.
        padding: 2.0, pitchDeg: 40,
    },
    {
        key: 'flak',
        title: 'Flak (Cannon, AA) — Thresher vs airborne drone',
        shooter: 'turretaaflak', target: 'fakeunit_aatarget',
        distance: 500, targetMode: 'flying', targetAlt: 240,
        // Flak turret is medium-tall + the target is up at y=240,
        // so the vertical extent dominates the framing.
        padding: 2.8, pitchDeg: 30,
        noTracking: true,
    },
    {
        key: 'ground-to-air',
        title: 'Ground-to-air SAM (StarburstLauncher) — Flail vs airborne drone',
        shooter: 'hoveraa', target: 'fakeunit_aatarget',
        distance: 600, targetMode: 'flying', targetAlt: 260,
        padding: 2.6, pitchDeg: 32,
        noTracking: true,
    },
    {
        key: 'air-to-air',
        title: 'Air-to-air — Swift vs airborne drone (both warped to altitude)',
        shooter: 'planefighter', target: 'fakeunit_aatarget',
        distance: 400, targetMode: 'flying', targetAlt: 250,
        shooterFlying: true,
        padding: 2.6, pitchDeg: 25,
    },
    // ── PLACEHOLDER: naval / torpedo ────────────────────────────────────
    // The test map green_flat_x34_v3 has no water, so torpedo /
    // depth-charge / hovertorpedo weapons can't fire (they refuse to
    // engage land targets). Restore this entry once a water-bearing
    // test map is added to the bench set:
    //   {
    //       key: 'torpedo',
    //       title: 'TorpedoLauncher — Duck vs naval target',
    //       shooter: 'amphraid', target: '<naval target>',
    //       distance: 400, targetMode: 'ground',
    //   },
];

function param(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
}

function numParam(name: string, fallback: number): number {
    const v = param(name);
    if (v == null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/// Spawn a unit, hold it on the spot if `holdFire`, optionally warp
/// it to altitude, and return its id. Throws on a parse failure so
/// the scenario aborts early rather than silently skipping a pair.
async function spawnConfigured(
    h: TestHarness,
    def: string, x: number, z: number, team: number,
    opts: { holdFire?: boolean; holdPos?: boolean; invulnerable?: boolean; flyAlt?: number } = {},
): Promise<number> {
    const out = await h.spawn(def, x, z, team, 1);
    const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!id) throw new Error(`[weapon-showcase] spawn parse failed for ${def}: ${out}`);

    const lua: string[] = [];
    if (opts.holdFire) {
        // CMD_MOVE_STATE=50 (0=Hold), CMD_FIRE_STATE=45 (0=hold-fire)
        lua.push(`Spring.GiveOrderToUnit(${id}, ${CMD_MOVE_STATE}, {0}, 0)`);
        lua.push(`Spring.GiveOrderToUnit(${id}, ${CMD_FIRE_STATE}, {0}, 0)`);
    } else if (opts.holdPos) {
        // Hold position only (still fire-at-will) — a mobile shooter that
        // should engage from its spawn spot rather than close the range.
        lua.push(`Spring.GiveOrderToUnit(${id}, ${CMD_MOVE_STATE}, {0}, 0)`);
    }
    if (opts.invulnerable) {
        lua.push(`Spring.SetUnitMaxHealth(${id}, 1e9)`);
        lua.push(`Spring.SetUnitHealth(${id}, 1e9)`);
    }
    if (opts.flyAlt && opts.flyAlt > 0) {
        // Per memory note `project_air_takeoff_gap.md`: ground-spawned
        // aircraft don't naturally climb; MoveCtrl-warp them up to the
        // wantedHeight so UpdateFlying takes over. The MoveCtrl is then
        // immediately disabled so normal flight controls resume.
        lua.push(`if Spring.MoveCtrl and Spring.MoveCtrl.Enable then`);
        lua.push(`  Spring.MoveCtrl.Enable(${id})`);
        lua.push(`  Spring.MoveCtrl.SetPosition(${id}, ${x}, ${opts.flyAlt}, ${z})`);
        lua.push(`  Spring.MoveCtrl.Disable(${id})`);
        lua.push(`end`);
    }
    if (lua.length > 0) await h.lua(lua.join('\n'));
    return id;
}

/// Tear down whatever's currently alive on either team so the next
/// archetype starts from a clean board. Doing this between entries
/// keeps the per-pair frame budget consistent — leftover units can
/// otherwise distract the eye and steal a few render-pass cycles.
async function clearArena(h: TestHarness): Promise<void> {
    await h.clear();
    // One frame's slack so the entity-state stream catches up before
    // the next spawn arrives.
    await sleep(120);
}

async function fireOneEntry(
    h: TestHarness, w: WeaponEntry,
    dwellMs: number,
): Promise<void> {
    const half = w.distance * 0.5;
    const sx = MAP_CENTER - half, sz = MAP_CENTER;
    const tx = MAP_CENTER + half, tz = MAP_CENTER;

    const sId = await spawnConfigured(h, w.shooter, sx, sz, 0, {
        flyAlt: w.shooterFlying ? 200 : undefined,
        holdPos: w.shooterHoldPos,
    });
    const tId = await spawnConfigured(h, w.target, tx, tz, 1, {
        holdFire: true,
        invulnerable: true,
        flyAlt: w.targetMode === 'flying' ? (w.targetAlt ?? 220) : undefined,
    });

    if (w.extraSetup) {
        await h.lua(w.extraSetup
            .replace(/\$SID/g, String(sId))
            .replace(/\$TID/g, String(tId)));
    }

    // Give the entity-renderer a frame to learn about the new units
    // before we ask the camera to frame them. Without this the
    // cameraFitUnits call hits the case where one or both ids aren't
    // in the renderer yet and the fit silently degrades.
    await sleep(800);

    // Camera framing. Entries default to `cameraFitUnits` with the
    // per-entry padding+pitch overrides (or the scenario defaults of
    // 2.2 / 45°). Entries that explicitly set `cameraFocus` snap to a
    // ground point with `cameraHeight` instead — used by long-arc
    // weapons (nuke, starburst) whose projectile dwarfs the
    // shooter+target footprint and would be lost in a unit-fit.
    const padding = w.padding ?? DEFAULT_PADDING;
    const pitchDeg = w.pitchDeg ?? DEFAULT_PITCH;
    if (w.cameraFocus) {
        await h.cameraSnapToGround(w.cameraFocus.x, w.cameraFocus.z, {
            height: w.cameraHeight ?? 1000, pitchDeg, durationMs: 0,
        });
    } else {
        await h.cameraFitUnits([sId, tId], { padding, pitchDeg, durationMs: 0 });
    }
    h.select([sId]);
    // Tracking on by default — follows the selected shooter through
    // any movement. Disabled for nuke / SAM / Big Bertha where the
    // projectile arcs away from the shooter and a fixed camera reads
    // better.
    h.setTrackingCamera(!w.noTracking);

    // Stockpile pre-fill for nukes: the live stockpile timer is in
    // minutes — without the cheat the scenario would time out long
    // before the missile launched. The server `stockpile` verb sets
    // numStockpiled directly and wires u->stockpileWeapon if it isn't
    // yet, so this works the tick after spawn — no flaky sleep needed.
    if (w.stockpile) {
        await h.stockpile(sId, 4, 0);
    }

    // Issue the firing order. Three flavours:
    //   - DGun / true manual-fire (Commander) → CMD_MANUALFIRE at ground.
    //     The def's `canManualFire = true` so CommandAI accepts it.
    //   - Stockpile (staticnuke et al.) → CMD_ATTACK at ground. Even
    //     though the unit *visually* fires its stockpile weapon, the
    //     def has `canManualFire = false` so CommandAI silently drops a
    //     MANUALFIRE order. Attack-ground routes through the stockpile
    //     firing path.
    //   - Everything else → CMD_ATTACK against the unit id.
    if (w.manualFire) {
        await h.order(sId, CMD_MANUALFIRE, [tx, 0, tz]);
    } else if (w.stockpile) {
        await h.order(sId, CMD_ATTACK, [tx, 0, tz]);
    } else {
        await h.order(sId, CMD_ATTACK, [tId]);
    }

    console.log(`[weapon-showcase] ► ${w.key}: ${w.title}`);

    // Dwell. The scenario can be paused / resumed via the player's
    // own hotkeys — sleep() doesn't block those.
    //
    // Long-arc weapons pan the camera to the impact point partway through
    // the dwell so the detonation is on screen rather than off-frame. The
    // tracking camera (if any) is dropped first so it doesn't yank focus
    // back to the shooter. The next entry re-frames from scratch, so the
    // camera is implicitly "restored" for the following unit.
    if (w.impactCam) {
        const ic = w.impactCam;
        const launchDwell = Math.min(ic.delayMs, dwellMs);
        await sleep(launchDwell);
        h.setTrackingCamera(false);
        await h.cameraSnapToGround(tx, tz, {
            height: ic.height, pitchDeg: ic.pitchDeg ?? 45, durationMs: 1400,
        });
        await sleep(Math.max(0, dwellMs - launchDwell));
    } else {
        await sleep(dwellMs);
    }

    // Teardown happens in the outer loop via clearArena so failures
    // here still surface for the next entry.
}

const scenario: Scenario = {
    name: 'weapon-showcase',
    description: 'Slow-mo tour of every weapon archetype: lasers, beams, cannons, missiles, lightning, DGun, flak, AA, air-to-air, and the Trinity nuke. Camera zooms in close per pair.',
    map: 'green_flat_x34_v3',
    gameId: 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,

    async setup(h) {
        const only = param('only');
        const speed = numParam('speed', DEFAULT_SPEED);
        const dwellMs = numParam('dwellMs', DEFAULT_DWELL_MS);
        const fitAll = param('fitAll') === '1';

        const entries = only
            ? WEAPONS.filter((w) => w.key === only)
            : WEAPONS;
        if (entries.length === 0) {
            const known = WEAPONS.map((w) => w.key).join(', ');
            throw new Error(`[weapon-showcase] no entry "${only}". Known: ${known}`);
        }

        await h.setLogging({ combat: true, weapon: true, explosion: true });

        // ZK static weapons (e.g. staticheavyarty's "Very Heavy Plasma
        // Cannon") are gated by the energy-grid low-power system in
        // unit_mex_overdrive.lua: a pylon whose grid has no energy income
        // is flagged `lowpower` and its weapon is disabled. The bench team
        // has no economy, so static shooters never fire. Waiving the grid
        // requirement globally forces every pylon back to `lowpower=0`.
        // Mobile shooters aren't pylons, so they're unaffected.
        try {
            await h.lua(
                'if GG and GG.Overdrive and GG.Overdrive.SetNoGridRequirement then ' +
                'GG.Overdrive.SetNoGridRequirement(true) end');
        } catch (err) {
            console.warn('[weapon-showcase] grid-power waive failed:', err);
        }

        try {
            await h.simSpeed(speed);
        } catch (err) {
            console.warn(`[weapon-showcase] simSpeed(${speed}) failed:`, err);
        }

        console.log(`[weapon-showcase] ${entries.length} entry/entries @ ${speed}× sim speed, ${dwellMs}ms per entry`);
        console.log(`[weapon-showcase] hotkeys: + / -  speed | \\  reset speed | Pause  pause | T  toggle tracking`);

        if (fitAll) {
            // One-shot: lay every pair out along a single horizontal
            // line, no cycling. Useful for screenshots of all weapons
            // firing simultaneously. Pairs are spaced 1500 elmos apart
            // around the map centre; the camera fits the whole line.
            const allIds: number[] = [];
            const spacing = 1500;
            const startX = MAP_CENTER - (entries.length - 1) * 0.5 * spacing;
            for (let i = 0; i < entries.length; i++) {
                const w = entries[i];
                const cx = startX + i * spacing;
                const half = w.distance * 0.5;
                const sId = await spawnConfigured(h, w.shooter, cx - half, MAP_CENTER, 0, {
                    flyAlt: w.shooterFlying ? 200 : undefined,
                });
                const tId = await spawnConfigured(h, w.target, cx + half, MAP_CENTER, 1, {
                    holdFire: true,
                    invulnerable: true,
                    flyAlt: w.targetMode === 'flying' ? (w.targetAlt ?? 220) : undefined,
                });
                if (w.stockpile) {
                    await h.stockpile(sId, 4, 0);
                }
                if (w.manualFire) {
                    await h.order(sId, CMD_MANUALFIRE, [cx + half, 0, MAP_CENTER]);
                } else if (w.stockpile) {
                    // Attack-ground; stockpile units have canManualFire=false
                    await h.order(sId, CMD_ATTACK, [cx + half, 0, MAP_CENTER]);
                } else {
                    await h.order(sId, CMD_ATTACK, [tId]);
                }
                allIds.push(sId, tId);
                console.log(`[weapon-showcase] +${w.key}: ${w.title}`);
            }
            await h.cameraFitUnits(allIds, { padding: 1.4, pitchDeg: 45, durationMs: 0 });
            // No tracking in fit-all mode — the camera should stay
            // wide so all pairs remain in view.
            h.setTrackingCamera(false);
            return;
        }

        // Cycling mode: run each entry in turn. The whole loop owns
        // the dwellMs budget, and clears the arena between entries.
        for (const w of entries) {
            await clearArena(h);
            try {
                await fireOneEntry(h, w, dwellMs);
            } catch (err) {
                console.error(`[weapon-showcase] entry "${w.key}" threw:`, err);
                // Don't bail — try the next archetype.
            }
        }

        console.log(`[weapon-showcase] cycle complete. Reload the page to repeat.`);
    },
};

export default scenario;
