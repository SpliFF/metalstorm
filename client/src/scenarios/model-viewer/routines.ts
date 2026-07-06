/**
 * Showcase routines for the model-viewer harness (PLAN-model-harness §3).
 *
 * Each routine is a small async script against `window.test` + synced
 * Lua (`test.lua`), the same idiom as the weapon-showcase re-fire recipe
 * (docs/javascript.md). Every routine runs through a finally-style stage
 * reset (E2): dummies cleared, sim speed restored, stage unit respawned
 * if the routine destroyed it, camera re-framed.
 *
 * Target dummies are extra instances of the STAGE def on team 1 (the
 * null-AI enemy slot), made invulnerable + hold-fire — the documented
 * damagesink pattern without depending on any game-specific def.
 */

import type { TestHarness } from '../../core/test-harness.js';
import { sleep, parseUnitPos } from '../types.js';
import type { CapabilityProbe, ShowcaseId, ShowcaseSpec } from './capability-probe.js';

const CMD = {
    STOP: 0,
    MOVE: 10,
    ATTACK: 20,
    FIRE_STATE: 45,
    MOVE_STATE: 50,
    LOAD_UNITS: 75,
    UNLOAD_UNITS: 80,
} as const;

/** Published on `window.modelViewer.state` so capture mode and MCP-driven
 *  runs can await routine progress (§3). */
export interface ModelViewerState {
    phase: 'booting' | 'ready' | 'running' | 'capturing' | 'done' | 'error';
    def: string | null;
    team: number;
    stageUnitId: number | null;
    showcases: ShowcaseSpec[];
    running: ShowcaseId | null;
    /** E1: 'fallback-model' when the def spawned as a procedural shape. */
    badge: string | null;
    lastError: string | null;
    slowMo: boolean;
}

/** Everything a routine needs from the orchestrator (index.ts). */
export interface StageContext {
    h: TestHarness;
    center: { x: number; z: number };
    state: ModelViewerState;
    probe: CapabilityProbe | null;
    /** Sim-probed transportee def name (null = probe failed / no fit). */
    transportee: string | null;
    /** Repaint hook for the F8 panel. */
    notify: () => void;
    /** Clear stage + fresh spawn of the current (or given) def; returns
     *  the new stage unit id and re-anchors the orbit rig. */
    respawn(def?: string): Promise<number>;
}

function requireStage(ctx: StageContext): number {
    const id = ctx.state.stageUnitId;
    if (!id) throw new Error('no stage unit — pick a def / respawn first');
    return id;
}

async function spawnId(h: TestHarness, def: string, x: number, z: number, team: number): Promise<number> {
    const out = await h.spawn(def, x, z, team, 1);
    const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
    if (!id) throw new Error(`spawn parse failed for ${def}: ${out}`);
    return id;
}

/** Team-1 target dummy: invulnerable, hold-fire, hold-position. */
async function spawnDummy(ctx: StageContext, x: number, z: number): Promise<number> {
    const def = ctx.state.def!;
    const id = await spawnId(ctx.h, def, x, z, 1);
    await ctx.h.lua([
        `Spring.GiveOrderToUnit(${id}, ${CMD.MOVE_STATE}, {0}, 0)`,
        `Spring.GiveOrderToUnit(${id}, ${CMD.FIRE_STATE}, {0}, 0)`,
        `Spring.SetUnitMaxHealth(${id}, 1e9)`,
        `Spring.SetUnitHealth(${id}, 1e9)`,
    ].join('\n'));
    return id;
}

/** Wait until the unit is within `dist` of (x, z), or `timeoutMs`. */
async function waitNear(
    h: TestHarness, unitId: number, x: number, z: number, dist: number, timeoutMs: number,
): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        let pos: { x: number; z: number } | null = null;
        try {
            pos = parseUnitPos(await h.unitState(unitId));
        } catch {
            return false; // unit gone
        }
        if (pos && Math.hypot(pos.x - x, pos.z - z) <= dist) return true;
        await sleep(400);
    }
    return false;
}

/** Is the stage unit still alive server-side? */
export async function unitAlive(h: TestHarness, unitId: number): Promise<boolean> {
    try {
        const out = await h.unitState(unitId);
        return /\bid=\d+/.test(out);
    } catch {
        return false;
    }
}

// ── The routines ─────────────────────────────────────────────────────────

async function idle(ctx: StageContext): Promise<void> {
    requireStage(ctx);
    await sleep(5000);
}

/** Shared square circuit (walk/drive/fly/sail). Ends with a stop at the
 *  centre so the decel + idle transition is visible. */
async function circuit(ctx: StageContext, half: number, arriveDist: number): Promise<void> {
    const id = requireStage(ctx);
    const { x: cx, z: cz } = ctx.center;
    const corners: [number, number][] = [
        [cx + half, cz], [cx + half, cz + half], [cx - half, cz + half], [cx - half, cz],
    ];
    for (const [x, z] of corners) {
        await ctx.h.order(id, CMD.MOVE, [x, 0, z]);
        await waitNear(ctx.h, id, x, z, arriveDist, 30000);
    }
    await ctx.h.order(id, CMD.MOVE, [cx, 0, cz]);
    await waitNear(ctx.h, id, cx, cz, arriveDist, 30000);
    await ctx.h.order(id, CMD.STOP, []);
    await sleep(1500); // decel + settle into idle
}

async function turnInPlace(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const { x: cx, z: cz } = ctx.center;
    // Two short out-and-back legs in opposite directions force a full
    // heading reverse each time (tracks/feet shuffle, hull twist).
    for (const dx of [250, -250]) {
        await ctx.h.order(id, CMD.MOVE, [cx + dx, 0, cz]);
        await sleep(2500);
        await ctx.h.order(id, CMD.STOP, []);
        await sleep(800);
    }
    await ctx.h.order(id, CMD.MOVE, [cx, 0, cz]);
    await waitNear(ctx.h, id, cx, cz, 60, 15000);
    await ctx.h.order(id, CMD.STOP, []);
}

/**
 * Aim: dummy cycles through 3 bearings (traverse, far side, rear arc)
 * while the stage unit TRACKS it without firing — target set through
 * `Spring.SetUnitTarget`, firing blocked by pushing every weapon's
 * reloadState into the far future (aiming is independent of reload in
 * the sim, so turret/barrel still slew).
 */
async function aim(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const { x: cx, z: cz } = ctx.center;
    const dist = 380;
    const at = (deg: number): [number, number] => [
        cx + dist * Math.cos(deg * Math.PI / 180),
        cz + dist * Math.sin(deg * Math.PI / 180),
    ];
    const [x0, z0] = at(60);
    const dummy = await spawnDummy(ctx, x0, z0);
    const weapons = Math.max(1, ctx.probe?.weaponCount ?? 1);
    try {
        await ctx.h.lua([
            `local far = Spring.GetGameFrame() + 10 * 60 * 30`,
            `for i = 1, ${weapons} do pcall(Spring.SetUnitWeaponState, ${id}, i, "reloadState", far) end`,
            `pcall(Spring.SetUnitTarget, ${id}, ${dummy})`,
        ].join('\n'));
        for (const deg of [60, 180, 300]) {
            const [x, z] = at(deg);
            await ctx.h.lua([
                `if Spring.MoveCtrl and Spring.MoveCtrl.Enable then`,
                `  Spring.MoveCtrl.Enable(${dummy})`,
                `  Spring.MoveCtrl.SetPosition(${dummy}, ${x}, Spring.GetGroundHeight(${x}, ${z}), ${z})`,
                `  Spring.MoveCtrl.Disable(${dummy})`,
                `end`,
            ].join('\n'));
            await sleep(4000);
        }
    } finally {
        await ctx.h.lua([
            `for i = 1, ${weapons} do pcall(Spring.SetUnitWeaponState, ${id}, i, "reloadState", Spring.GetGameFrame()) end`,
            `pcall(Spring.SetUnitTarget, ${id})`,
        ].join('\n')).catch(() => { /* stage reset clears the rest */ });
    }
}

async function fire(ctx: StageContext, durationMs: number): Promise<void> {
    const id = requireStage(ctx);
    const { x: cx, z: cz } = ctx.center;
    const dummy = await spawnDummy(ctx, cx + 420, cz);
    await sleep(400);
    await ctx.h.order(id, CMD.ATTACK, [dummy]);
    await sleep(durationMs);
    await ctx.h.order(id, CMD.STOP, []);
}

/** Pick the cheapest build option of the stage def, server-side. Returns
 *  `{ defId, name }` or null. */
async function cheapestBuildOption(ctx: StageContext): Promise<{ defId: number; name: string } | null> {
    const out = await ctx.h.lua(`
local t
for id, d in pairs(UnitDefs) do
  if d.name == ${JSON.stringify(ctx.state.def)} then t = d break end
end
if not t then return "" end
local best, bestId, bestCost
for i, bid in ipairs(t.buildOptions or {}) do
  local bd = UnitDefs[bid]
  if bd then
    local c = bd.metalCost or 1e9
    if not best or c < bestCost then best, bestId, bestCost = bd.name, bid, c end
  end
end
if not best then return "" end
return best .. "|" .. bestId`.trim());
    const m = out.trim().match(/^([^|]+)\|(\d+)$/);
    return m ? { name: m[1], defId: Number(m[2]) } : null;
}

async function build(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const opt = await cheapestBuildOption(ctx);
    if (!opt) throw new Error('no buildable option found for this def');
    const { x: cx, z: cz } = ctx.center;
    // Build orders are negative cmdIds: -targetDefId, params = pos + facing.
    await ctx.h.order(id, -opt.defId, [cx + 220, 0, cz + 120, 0]);
    await sleep(14000);
    await ctx.h.order(id, CMD.STOP, []);
    // Product teardown happens in the stage reset (team-0 sweep).
}

async function produce(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const opt = await cheapestBuildOption(ctx);
    if (!opt) throw new Error('factory has no build options');
    await ctx.h.order(id, -opt.defId, []);
    await sleep(16000); // open → build → rolloff
    await ctx.h.order(id, CMD.STOP, []);
}

async function loadUnload(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const tDef = ctx.transportee;
    if (!tDef) throw new Error('no transportable def found (sim probe came back empty)');
    const { x: cx, z: cz } = ctx.center;
    const cargo = await spawnId(ctx.h, tDef, cx + 150, cz, 0);
    await ctx.h.lua(`Spring.GiveOrderToUnit(${cargo}, ${CMD.MOVE_STATE}, {0}, 0)`);
    await sleep(500);
    await ctx.h.order(id, CMD.LOAD_UNITS, [cargo]);
    await sleep(8000);
    await ctx.h.order(id, CMD.MOVE, [cx, 0, cz + 260]);
    await sleep(6000);
    await ctx.h.order(id, CMD.UNLOAD_UNITS, [cx, 0, cz + 260, 140]);
    await sleep(8000);
    // Cargo is swept by the stage reset.
}

async function damageReaction(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const hp = Math.max(1, ctx.probe?.health ?? 100);
    for (let i = 0; i < 3; i++) {
        await ctx.h.damage(id, hp * 0.15);
        await sleep(900);
    }
    await sleep(1500); // smoke / hit-reaction linger
}

async function explode(ctx: StageContext): Promise<void> {
    const id = requireStage(ctx);
    const { x: cx, z: cz } = ctx.center;
    await ctx.h.kill(id, true);
    ctx.state.stageUnitId = null;
    ctx.notify();
    await sleep(3500); // camera holds the latched anchor through the death FX
    if (ctx.probe?.hasWreck) {
        const out = await ctx.h.lua(`
local fs = Spring.GetFeaturesInRectangle(${cx - 250}, ${cz - 250}, ${cx + 250}, ${cz + 250})
if fs and fs[1] then
  local x, y, z = Spring.GetFeaturePosition(fs[1])
  return x .. "," .. z
end
return ""`.trim());
        const m = out.trim().match(/^([-\d.]+),([-\d.]+)$/);
        if (m) {
            await ctx.h.orbit({ x: Number(m[1]), z: Number(m[2]), radius: 60 }, { follow: false });
            await sleep(4000); // wreckage inspect
        }
    }
    await ctx.respawn(); // restores the stage + re-anchors the orbit
}

// ── Dispatcher + stage reset (E2) ────────────────────────────────────────

const ROUTINES: Record<ShowcaseId, (ctx: StageContext) => Promise<void>> = {
    'idle': idle,
    'circuit': (c) => circuit(c, 300, 60),
    'turn-in-place': turnInPlace,
    'fly-circuit': (c) => circuit(c, 500, 180),
    'sail-circuit': (c) => circuit(c, 300, 80),
    'aim': aim,
    'volley': (c) => fire(c, 6000),
    'sustained': (c) => fire(c, 10000),
    'build': build,
    'produce': produce,
    'load-unload': loadUnload,
    'damage': damageReaction,
    'explode': explode,
    'respawn': (c) => c.respawn().then(() => undefined),
    'squad-fanout': async () => {
        throw new Error('squad rendering not wired yet (beta-units B1) — fan-out is a placeholder');
    },
};

/**
 * Run one showcase with the E2 stage-reset discipline. Rejections are
 * captured into `state.lastError` (and rethrown for callers that await).
 */
export async function runShowcase(ctx: StageContext, id: ShowcaseId): Promise<void> {
    if (ctx.state.running) throw new Error(`showcase "${ctx.state.running}" still running`);
    ctx.state.running = id;
    ctx.state.lastError = null;
    ctx.state.phase = 'running';
    ctx.notify();
    const slow = ctx.state.slowMo;
    try {
        if (slow) await ctx.h.simSpeed(0.25).catch(() => { /* speed is best-effort */ });
        await ROUTINES[id](ctx);
    } catch (err) {
        ctx.state.lastError = (err as Error)?.message ?? String(err);
        throw err;
    } finally {
        await resetStage(ctx).catch((err) =>
            console.warn('[model-viewer] stage reset failed:', err));
        ctx.state.running = null;
        if (ctx.state.phase === 'running') ctx.state.phase = 'ready';
        ctx.notify();
    }
}

/**
 * E2 stage reset: sim speed back to 1×, team-1 dummies gone, stray team-0
 * products gone (everything but the stage unit), stage unit alive, camera
 * re-framed. Also wired to the panel's "stop/reset" button.
 */
export async function resetStage(ctx: StageContext): Promise<void> {
    await ctx.h.simSpeed(1).catch(() => { /* best-effort */ });
    await ctx.h.clear(1).catch(() => { /* team-1 dummy sweep */ });
    const stageId = ctx.state.stageUnitId ?? 0;
    await ctx.h.lua(`
for _, uid in ipairs(Spring.GetTeamUnits(0) or {}) do
  if uid ~= ${stageId} then Spring.DestroyUnit(uid, false, true) end
end
return ""`.trim()).catch(() => { /* sweep is best-effort */ });
    if (ctx.state.stageUnitId && !(await unitAlive(ctx.h, ctx.state.stageUnitId))) {
        ctx.state.stageUnitId = null;
    }
    if (!ctx.state.stageUnitId && ctx.state.def) {
        await ctx.respawn();
    } else {
        await ctx.h.orbitFrame().catch(() => { /* rig may be off */ });
    }
}
