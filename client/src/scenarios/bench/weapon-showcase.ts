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
 * **Metalstorm port (2026-08-04).** The ZK edition toured thirteen
 * archetypes (BeamLaser, LightningCannon, DGun, StarburstLauncher, the
 * Trinity nuke…). Metalstorm's whole arsenal is four WeaponDef types —
 * **Cannon, MissileLauncher, AircraftBomb, TorpedoLauncher** — so the
 * tour is genuinely shorter, not abbreviated. What that costs is stated
 * plainly rather than faked: there is no hit-scan weapon in Metalstorm,
 * so the beam-rendering path has no coverage here at all, and the
 * stockpile / manual-fire (DGun) firing paths have no Metalstorm caller.
 * Those branches were deleted rather than left dead — a `?only=nuke` that
 * silently matches nothing is worse than one that lists what exists.
 *
 * Coverage (the unit carrying each weapon in parens):
 *   - Cannon, rapid short         (ms_mechs_s1 — MS_MG_S2, r 380)
 *   - Cannon, autocannon          (ms_tanks_s2 — MS_AC_S3, r 520)
 *   - Cannon, railgun             (ms_mechs_s4 — MS_RAILGUN_S3, r 900)
 *   - Cannon, ballistic howitzer  (ms_artillery_s2 — MS_HOWITZER_S1, r 1100)
 *   - Cannon, flak vs air         (ms_staticdefense_s3 — MS_FLAK_S2, r 800)
 *   - MissileLauncher, cruise     (fable_colossus — MS_MISSILE_CRUISE_S1, r 2400)
 *   - MissileLauncher, SAM        (ms_mechs_s3 — MS_MISSILE_AA_S2, r 950)
 *   - AircraftBomb                (ms_bombers_s2 — MS_BOMB_S2)
 *   - Air-to-air                  (ms_fighters_s3 vs an airborne fighter)
 *   - TorpedoLauncher             (PLACEHOLDER — the test map has no water)
 *
 * URL params (all optional):
 *   ?scenario=weapon-showcase
 *   ?scenario=weapon-showcase&only=howitzer     run just the named entry
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

// Map metrics: green_flat_x34_v3 is 17408×17408 elmos, completely flat.
const MAP_CENTER = 8704;

/** Static, unarmed, 12000 HP, large footprint — the closest thing
 *  Metalstorm has to a dedicated damage sink. Every ground entry shoots
 *  at one; `spawnConfigured` lifts its HP to 1e9 so a long dwell doesn't
 *  end early in a kill. */
const GROUND_TARGET = 'ms_garrison';
/** Air target for the AA entries. Metalstorm has no equivalent of ZK's
 *  `fakeunit_aatarget` drone, so a real fighter is MoveCtrl-warped to
 *  altitude and pinned there on hold-fire. */
const AIR_TARGET = 'ms_fighters_s1';

// Phase V capture hook. The cycle publishes the active archetype on
// `window.__showcase` so an external driver (screenshot capture) can sync
// to each entry instead of guessing at the 18 s dwell timing.
interface ShowcaseProgress {
    keys: string[]; total: number;
    index: number; key: string; title: string;
    phase: 'firing' | 'impact' | 'cleared' | 'done';
    enteredAt: number;
}
function setShowcaseEntry(keys: string[], index: number, w: { key: string; title: string }): void {
    (window as unknown as { __showcase?: ShowcaseProgress }).__showcase = {
        keys, total: keys.length, index, key: w.key, title: w.title,
        phase: 'firing', enteredAt: Date.now(),
    };
}
function setShowcasePhase(phase: ShowcaseProgress['phase']): void {
    const s = (window as unknown as { __showcase?: ShowcaseProgress }).__showcase;
    if (s) { s.phase = phase; s.enteredAt = Date.now(); }
}

// Default sim-speed and per-pair dwell. 0.25× makes projectile travel
// readable; 18 s of wall time = 4.5 s of sim time, comfortably more
// than a reload for every weapon listed below.
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
    /// Tuned per-weapon so the target sits comfortably inside range —
    /// and, on multi-weapon shooters, so that only the weapon this
    /// entry is about can reach (that is how the cruise-missile entry
    /// isolates the launcher from the autocannon on the same unit).
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
    /// the bomber and air-to-air entries. We MoveCtrl-warp it after
    /// spawn so the engine's stuck-on-ground takeoff path doesn't gate
    /// the test.
    shooterFlying?: boolean;
    /// Per-entry camera padding override. `cameraFitUnits` defaults to
    /// 1.4; this scenario default is `DEFAULT_PADDING` (2.2 — wide
    /// enough that both units sit comfortably inside the frame with
    /// projectile travel between them). Tall buildings need 2.8–3.2 so
    /// the silhouette doesn't clip the top of the viewport; very-close
    /// pairs can drop to 1.8 to keep the action readable.
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
    /// Used by long-range weapons whose projectile arc dwarfs the
    /// shooter+target footprint (a unit-fit would lose the arc).
    cameraFocus?: { x: number; z: number };
    /// Camera height for `cameraFocus`-mode entries. In elmos above the
    /// ground point.
    cameraHeight?: number;
    /// `true` to disable the tracking camera for this entry. Defaults
    /// to `false` (tracking on, follows the selected shooter). Disable
    /// when the projectile arcs far away from the shooter (artillery,
    /// cruise missiles) so the camera stays fixed and the arc plays
    /// through the frame instead of being chased.
    noTracking?: boolean;
    /// Hold the (mobile) shooter in place so it fires from its spawn
    /// position instead of advancing to optimal range. Needed for mobile
    /// artillery and the cruise-missile walker — a ground-fit camera
    /// assumes the shooter stays put, and closing the range would let a
    /// shorter-ranged second weapon steal the shot. Aircraft must NOT
    /// set this (they need to move).
    shooterHoldPos?: boolean;
    /// Long-arc weapons (howitzer, cruise missile) launch a projectile
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
        key: 'mg',
        title: 'Cannon (rapid, short) — MS_MG_S2 from an ms_mechs_s1 recon walker',
        shooter: 'ms_mechs_s1', target: GROUND_TARGET,
        distance: 300, targetMode: 'ground',
        padding: 2.2, pitchDeg: 38,
    },
    {
        key: 'autocannon',
        title: 'Cannon (autocannon) — MS_AC_S3 from an ms_tanks_s2',
        shooter: 'ms_tanks_s2', target: GROUND_TARGET,
        distance: 450, targetMode: 'ground',
        padding: 2.2, pitchDeg: 40,
    },
    {
        key: 'railgun',
        title: 'Cannon (railgun, flat/fast) — MS_RAILGUN_S3 from an ms_mechs_s4',
        shooter: 'ms_mechs_s4', target: GROUND_TARGET,
        distance: 700, targetMode: 'ground',
        // The mech also carries MS_AC_S3 (520) and MS_FLAK_S2 (800);
        // 700 elmos is past the autocannon so the railgun is what fires
        // at the ground target, and flak won't engage a building.
        shooterHoldPos: true,
        padding: 2.6, pitchDeg: 35,
    },
    {
        key: 'howitzer',
        title: 'Cannon (ballistic arc) — MS_HOWITZER_S1 from an ms_artillery_s2',
        shooter: 'ms_artillery_s2', target: GROUND_TARGET,
        distance: 900, targetMode: 'ground',
        shooterHoldPos: true,
        // Focus mid-arc with extra height so the climb + descent is
        // visible end-to-end. Tracking off — the shell leaves the
        // shooter immediately.
        cameraFocus: { x: MAP_CENTER, z: MAP_CENTER },
        cameraHeight: 1400, pitchDeg: 40,
        noTracking: true,
        impactCam: { delayMs: 5500, height: 700, pitchDeg: 45 },
    },
    {
        key: 'cruise',
        title: 'MissileLauncher (cruise) — MS_MISSILE_CRUISE_S1 from a fable_colossus',
        shooter: 'fable_colossus', target: GROUND_TARGET,
        // 2000 elmos: inside the cruise missile's 2400 and far outside
        // the colossus's other weapon (MS_AC_S3, 520), so the entry
        // shows the launcher and nothing else.
        distance: 2000, targetMode: 'ground',
        shooterHoldPos: true,
        cameraFocus: { x: MAP_CENTER, z: MAP_CENTER },
        cameraHeight: 2200, pitchDeg: 35,
        noTracking: true,
        impactCam: { delayMs: 9000, height: 1200, pitchDeg: 45 },
    },
    {
        key: 'sam',
        title: 'MissileLauncher (ground-to-air SAM) — MS_MISSILE_AA_S2 from an ms_mechs_s3 vs an airborne fighter',
        shooter: 'ms_mechs_s3', target: AIR_TARGET,
        distance: 600, targetMode: 'flying', targetAlt: 260,
        shooterHoldPos: true,
        padding: 2.6, pitchDeg: 32,
        noTracking: true,
    },
    {
        key: 'flak',
        title: 'Cannon (flak, AA) — MS_FLAK_S2 from an ms_staticdefense_s3 vs an airborne fighter',
        shooter: 'ms_staticdefense_s3', target: AIR_TARGET,
        distance: 500, targetMode: 'flying', targetAlt: 240,
        // The turret is medium-tall and the target is up at y=240, so
        // the vertical extent dominates the framing.
        padding: 2.8, pitchDeg: 30,
        noTracking: true,
    },
    {
        key: 'bomb',
        title: 'AircraftBomb — MS_BOMB_S2 dropped by an ms_bombers_s2',
        shooter: 'ms_bombers_s2', target: GROUND_TARGET,
        distance: 900, targetMode: 'ground',
        // AircraftBomb needs a physical fly-over, not just LOS + range
        // (CBombDropper::TestRange), so give the bomber a real approach
        // run and do NOT hold its position.
        shooterFlying: true,
        padding: 2.8, pitchDeg: 35,
    },
    {
        key: 'air-to-air',
        title: 'Air-to-air — ms_fighters_s3 vs an airborne fighter (both warped to altitude)',
        shooter: 'ms_fighters_s3', target: AIR_TARGET,
        distance: 400, targetMode: 'flying', targetAlt: 250,
        shooterFlying: true,
        padding: 2.6, pitchDeg: 25,
    },
    // ── PLACEHOLDER: naval / torpedo ────────────────────────────────────
    // Metalstorm has TorpedoLauncher (ms_torpedo_s1..3 on the subs,
    // ms_depthcharge_s1 on ms_ships_s2) but green_flat_x34_v3 has no
    // water, so none of them can fire — they refuse to engage land
    // targets, and the sub can't spawn afloat in the first place.
    // Restore this entry once a water-bearing map joins the bench set:
    //   {
    //       key: 'torpedo',
    //       title: 'TorpedoLauncher — ms_subs_s1 vs a surface ship',
    //       shooter: 'ms_subs_s1', target: 'ms_ships_s1',
    //       distance: 500, targetMode: 'ground',
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

    // Give the entity-renderer a frame to learn about the new units
    // before we ask the camera to frame them. Without this the
    // cameraFitUnits call hits the case where one or both ids aren't
    // in the renderer yet and the fit silently degrades.
    await sleep(800);

    // Camera framing. Entries default to `cameraFitUnits` with the
    // per-entry padding+pitch overrides (or the scenario defaults of
    // 2.2 / 45°). Entries that explicitly set `cameraFocus` snap to a
    // ground point with `cameraHeight` instead — used by long-arc
    // weapons whose projectile dwarfs the shooter+target footprint and
    // would be lost in a unit-fit.
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
    // any movement. Disabled for artillery / cruise / AA where the
    // projectile arcs away from the shooter and a fixed camera reads
    // better.
    h.setTrackingCamera(!w.noTracking);

    await h.order(sId, CMD_ATTACK, [tId]);

    console.log(`[weapon-showcase] ► ${w.key}: ${w.title}`);
    setShowcasePhase('firing');

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
        setShowcasePhase('impact');
        await sleep(Math.max(0, dwellMs - launchDwell));
    } else {
        await sleep(dwellMs);
    }

    // Teardown happens in the outer loop via clearArena so failures
    // here still surface for the next entry.
}

const scenario: Scenario = {
    name: 'weapon-showcase',
    description: "Slow-mo tour of Metalstorm's weapon archetypes: cannons (MG, autocannon, railgun, howitzer, flak), cruise and SAM missiles, aircraft bombs and air-to-air. Camera zooms in close per pair.",
    map: 'green_flat_x34_v3',
    gameId: 'metalstorm',
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
            // firing simultaneously. Pairs are spaced 2500 elmos apart
            // around the map centre (wide enough for the 2000-elmo
            // cruise pair); the camera fits the whole line.
            const allIds: number[] = [];
            const spacing = 2500;
            const startX = MAP_CENTER - (entries.length - 1) * 0.5 * spacing;
            for (let i = 0; i < entries.length; i++) {
                const w = entries[i];
                const cx = startX + i * spacing;
                const half = w.distance * 0.5;
                const sId = await spawnConfigured(h, w.shooter, cx - half, MAP_CENTER, 0, {
                    flyAlt: w.shooterFlying ? 200 : undefined,
                    holdPos: w.shooterHoldPos,
                });
                const tId = await spawnConfigured(h, w.target, cx + half, MAP_CENTER, 1, {
                    holdFire: true,
                    invulnerable: true,
                    flyAlt: w.targetMode === 'flying' ? (w.targetAlt ?? 220) : undefined,
                });
                await h.order(sId, CMD_ATTACK, [tId]);
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
        const keys = entries.map((w) => w.key);
        for (let i = 0; i < entries.length; i++) {
            const w = entries[i];
            await clearArena(h);
            setShowcaseEntry(keys, i, w);
            try {
                await fireOneEntry(h, w, dwellMs);
            } catch (err) {
                console.error(`[weapon-showcase] entry "${w.key}" threw:`, err);
                // Don't bail — try the next archetype.
            }
            setShowcasePhase('cleared');
        }

        setShowcasePhase('done');
        console.log(`[weapon-showcase] cycle complete. Reload the page to repeat.`);
    },
};

export default scenario;
