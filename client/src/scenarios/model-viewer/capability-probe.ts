/**
 * Capability probe for the model-viewer harness (PLAN-model-harness §2).
 *
 * Buttons are DERIVED, not hardcoded: the panel inspects the unit's def
 * and shows only the showcases that apply. The probe reads the streamed
 * `UnitDefInfo` wire form (client DefCache, via the worker bridge) —
 * behaviour booleans live in the `flags` bitfield (protocol.fbs
 * GameUnitDef.flags; bit names mirrored from lua-ui-host.ts
 * buildLuaUnitDef). Sim-only facts (transportee choice) are probed via
 * `test.lua` against the sim's own UnitDefs — see
 * `transporteeProbeLua()`.
 *
 * Everything here is pure — vitest fixtures drive def shapes → expected
 * button sets (§11).
 */

/** GameUnitDef.flags bits (protocol.fbs; decoded like lua-ui-host.ts). */
export const UDF = {
    IS_BUILDER: 1 << 0,
    CAN_MOVE: 1 << 1,
    CAN_FLY: 1 << 2,
    CAN_SUBMERGE: 1 << 3,
    FLOAT_ON_WATER: 1 << 4,
    CAN_MANUAL_FIRE: 1 << 7,
    IS_FACTORY: 1 << 11,
    IS_BUILDING: 1 << 12,
} as const;

/** The subset of the streamed UnitDefInfo wire form the probe reads. */
export interface DefWireLike {
    name: string;
    humanName?: string;
    flags: number;
    speed?: number;
    weaponDefIds?: number[];
    buildOptions?: number[];
    transportCapacity?: number;
    transportMass?: number;
    transportSize?: number;
    wreckName?: string;
    health?: number;
    customParams?: Record<string, string>;
}

export interface CapabilityProbe {
    name: string;
    humanName: string;
    isBuilder: boolean;
    canMove: boolean;
    canFly: boolean;
    canSubmerge: boolean;
    floatOnWater: boolean;
    canManualFire: boolean;
    isFactory: boolean;
    isBuilding: boolean;
    weaponCount: number;
    buildOptionCount: number;
    transportCapacity: number;
    transportMass: number;
    transportSize: number;
    hasWreck: boolean;
    /** Metalstorm squads (`customParams.squad_size > 1`); 1 otherwise. */
    squadSize: number;
    health: number;
    speed: number;
}

export function probeFromDef(d: DefWireLike): CapabilityProbe {
    const flags = d.flags ?? 0;
    const squadSize = Number(d.customParams?.squad_size ?? '1');
    return {
        name: d.name,
        humanName: d.humanName || d.name,
        isBuilder: (flags & UDF.IS_BUILDER) !== 0,
        canMove: (flags & UDF.CAN_MOVE) !== 0,
        canFly: (flags & UDF.CAN_FLY) !== 0,
        canSubmerge: (flags & UDF.CAN_SUBMERGE) !== 0,
        floatOnWater: (flags & UDF.FLOAT_ON_WATER) !== 0,
        canManualFire: (flags & UDF.CAN_MANUAL_FIRE) !== 0,
        isFactory: (flags & UDF.IS_FACTORY) !== 0,
        isBuilding: (flags & UDF.IS_BUILDING) !== 0,
        weaponCount: d.weaponDefIds?.length ?? 0,
        buildOptionCount: d.buildOptions?.length ?? 0,
        transportCapacity: d.transportCapacity ?? 0,
        transportMass: d.transportMass ?? 0,
        transportSize: d.transportSize ?? 0,
        hasWreck: !!d.wreckName,
        squadSize: Number.isFinite(squadSize) && squadSize > 1 ? Math.floor(squadSize) : 1,
        health: d.health ?? 0,
        speed: d.speed ?? 0,
    };
}

export type ShowcaseId =
    | 'idle'
    | 'construction'     // buildings only: nanoframe → complete, real build-anim
    | 'circuit'          // ground walk/drive square
    | 'turn-in-place'
    | 'fly-circuit'      // take-off, fly square, land
    | 'sail-circuit'     // ship/sub (dive/surface note in the label)
    | 'aim'
    | 'volley'
    | 'sustained'
    | 'build'
    | 'produce'
    | 'load-unload'
    | 'damage'
    | 'explode'          // explode → wreck inspect → respawn
    | 'respawn'
    | 'squad-fanout';

export interface ShowcaseSpec {
    id: ShowcaseId;
    label: string;
    /** Extra context shown as the button tooltip. */
    hint?: string;
}

/**
 * §2 table: capability probe → available showcases, in panel order.
 */
export function deriveShowcases(p: CapabilityProbe): ShowcaseSpec[] {
    const out: ShowcaseSpec[] = [];
    out.push({
        id: 'idle', label: 'Idle',
        hint: 'hold still 5 s — idle anim / stance (plays an authored "idle" clip if the model ships one)',
    });

    // Buildings have no move/turn showcase of their own — this is the
    // building-equivalent flagship row: a real nanoframe (Spring.CreateUnit
    // build=true) ramped to completion via the same buildProgress field
    // real construction drives, exercising the actual client build-anim
    // renderer rather than a bespoke building-only visual.
    if (p.isBuilding) {
        out.push({
            id: 'construction', label: 'Construction',
            hint: 'nanoframe → complete (buildProgress ramp; real client build-animation)',
        });
    }

    // canMove alone is not enough: ZK factories carry canMove=true with
    // speed=0 (live-found) — a def that can't attain speed can't run a
    // movement showcase.
    const mobile = p.canMove && p.speed > 0;
    if (mobile && p.canFly) {
        out.push({ id: 'fly-circuit', label: 'Take-off + fly circuit', hint: 'climb, square circuit, land' });
    } else if (mobile && (p.floatOnWater || p.canSubmerge) && !p.isBuilding) {
        out.push({
            id: 'sail-circuit',
            label: p.canSubmerge ? 'Sail circuit (sub)' : 'Sail circuit',
            hint: p.canSubmerge
                ? 'square circuit; dive/surface needs a water map'
                : 'square circuit; needs a water map',
        });
    } else if (mobile) {
        out.push({ id: 'circuit', label: 'Walk/Drive circuit', hint: '±300 elmo square, ends at centre' });
        out.push({ id: 'turn-in-place', label: 'Turn in place', hint: 'reverse heading twice' });
    }

    if (p.weaponCount > 0) {
        out.push({
            id: 'aim',
            label: p.weaponCount > 1 ? `Aim (${p.weaponCount} weapons)` : 'Aim (track only)',
            hint: 'turret/barrel tracks a dummy through 3 arcs without firing',
        });
        out.push({ id: 'volley', label: 'Fire volley', hint: 'one attack pass at an invulnerable dummy' });
        out.push({ id: 'sustained', label: 'Sustained fire (10 s)', hint: 'muzzle events → FX/bindings' });
    }

    if (p.isFactory && p.buildOptionCount > 0) {
        out.push({ id: 'produce', label: 'Produce (factory)', hint: 'queue cheapest unit; open/build/rolloff' });
    } else if (p.isBuilder && p.buildOptionCount > 0) {
        out.push({ id: 'build', label: 'Build', hint: 'construct the cheapest buildable nearby' });
    }

    if (p.transportCapacity > 0) {
        out.push({ id: 'load-unload', label: 'Load / carry / unload', hint: 'transportee picked via sim probe' });
    }

    out.push({ id: 'damage', label: 'Damage reaction', hint: '3 × 15% max-health hits' });
    out.push({
        id: 'explode',
        label: p.hasWreck ? 'Explode → wreckage' : 'Explode',
        hint: p.hasWreck ? 'self-D, inspect the wreck, respawn' : 'self-D, respawn (def has no wreck)',
    });
    out.push({ id: 'respawn', label: 'Respawn', hint: 'clear stage + fresh spawn' });

    if (p.squadSize > 1) {
        out.push({
            id: 'squad-fanout',
            label: `Squad fan-out (${p.squadSize})`,
            hint: 'isolate the member model — needs squad rendering (beta-units), not yet wired',
        });
    }
    return out;
}

// ── Generic clip buttons (PLAN-model-harness §2 last row / task 6) ───────

/** One "Play clip: X" button per authored .glb clip. The §2 rule is
 *  "model has clip X *not covered above*" — but the sim never triggers
 *  .glb clips at all today (the fx-offload animator will map sim states
 *  to clips later), so EVERY authored clip counts as not-covered. Names
 *  are deduped + sorted so the panel is deterministic. */
export function deriveClipButtons(
    clipNames: readonly string[],
): { clip: string; label: string }[] {
    return [...new Set(clipNames)]
        .sort()
        .map((c) => ({ clip: c, label: `Play clip: ${c}` }));
}

// ── Transportee selection (PLAN-model-harness §3 load/unload) ────────────

/**
 * Synced-Lua probe that picks the cheapest transportable def using the
 * sim's own UnitDefs — the def-level conditions of
 * CTransportCAI::CanTransport (cantBeTransported, mass vs transportMass,
 * footprint vs transportSize), evaluated server-side so we never
 * re-implement the rule against client data. Returns the def name or ''.
 */
export function transporteeProbeLua(transportDefName: string): string {
    return `
local t
for id, d in pairs(UnitDefs) do
  if d.name == ${JSON.stringify(transportDefName)} then t = d break end
end
if not t then return "" end
local best, bestCost
for id, d in pairs(UnitDefs) do
  if d.canMove and not d.canFly and not d.cantBeTransported
     and not d.isImmobile
     and (d.mass or math.huge) <= (t.transportMass or 0)
     and (d.xsize or math.huge) <= (t.transportSize or 0) * 2 then
    local c = d.metalCost or 1e9
    if not best or c < bestCost then best = d.name bestCost = c end
  end
end
return best or ""`.trim();
}

/** Strip the literal double quotes the LuaRules exec scope wraps around
 *  string return values (live-found: `return "x"` arrives as `"x"` with
 *  the quote characters included). */
export function unquoteExec(output: string): string {
    const s = output.trim();
    return s.length >= 2 && s.startsWith('"') && s.endsWith('"')
        ? s.slice(1, -1) : s;
}

/** Validate the sim probe's reply (exec output is free text on errors). */
export function parseTransporteeProbe(output: string): string | null {
    const s = unquoteExec(output);
    if (!s || /\s/.test(s)) return null;
    return s;
}

/** Client-side fallback pick when the sim probe fails: same def-level
 *  conditions over the streamed defs. Prefers the cheapest by health as a
 *  cost stand-in (metalCost is on the wire too when present). */
export interface TransporteeCandidate {
    name: string;
    flags: number;
    mass?: number;
    xsize?: number;
    metalCost?: number;
}

export function pickTransporteeFallback(
    candidates: readonly TransporteeCandidate[],
    transport: { transportMass: number; transportSize: number },
): string | null {
    let best: TransporteeCandidate | null = null;
    for (const c of candidates) {
        if (!(c.flags & UDF.CAN_MOVE) || (c.flags & UDF.CAN_FLY)) continue;
        if ((c.mass ?? Infinity) > transport.transportMass) continue;
        if ((c.xsize ?? Infinity) > transport.transportSize * 2) continue;
        if (!best || (c.metalCost ?? Infinity) < (best.metalCost ?? Infinity)) best = c;
    }
    return best?.name ?? null;
}
