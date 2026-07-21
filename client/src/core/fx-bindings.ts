/**
 * PLAN-fx-offload X4 — declarative FX binding interpreter (§2, §10 task 1).
 *
 * Per-entity-def FX behaviour ("engine loops when moving", "turret servo
 * hums while the turret rotates", "track UVs scroll with ground speed") is
 * authored as data (see data/games/metalstorm/effects/bindings.example.json)
 * instead of a per-frame Lua/JS `onUpdate` script. This module evaluates all
 * bindings for all visible entities once per frame; nothing here runs Lua or
 * dispatches a per-entity closure — evalOne() is a flat switch over a
 * precompiled binding array.
 *
 * Deliberately engine-agnostic (no Babylon/EntityRenderer/AudioManager
 * imports) so it stays unit-testable without a renderer or AudioContext —
 * callers inject an `FxSinks` implementation that knows how to move a
 * piece, start a loop voice, etc. `client/units/<def>/bindings.json` (or a
 * Lua table export marshalled to the same plain-object shape — `parseBindingSet`
 * only cares about the parsed shape, not its origin, so both loaders share
 * this one parser per §2) is the on-disk format `parseBindingSet` reads.
 *
 * Design note vs. the plan's literal "one pass per binding type" phrasing
 * (§2): bindings are compiled per-def into a flat array once at
 * `registerDef()` time, and `evaluate()` walks entities once, dispatching
 * each entity's own small binding array inline. Because binding sets per
 * def are tiny (a handful of entries — see the example fixture) and the
 * per-def lookup is O(1), this costs the same as bucketing by type across
 * the whole scene while staying allocation-free in the JS sense (no
 * `Object.keys`/array work inside the hot loop) — a documented
 * simplification of the architecture sketch, not a behavioural difference.
 *
 * FIDELITY-STANDIN: `uvScroll` and `emitter` bindings evaluate their
 * conditions/rates correctly (so the per-frame *script* cost is deleted
 * today) but have no faithful visual sink yet — per-instance UV scroll and
 * GPU particles are X2/X3 (PLAN-fx-offload), evidence-gated behind
 * PLAN-perf N5 and explicitly out of scope for this session. The stub
 * sinks below warn once per (def, binding) and do nothing else. `pieceSpin`
 * and `loopSound` DO have real sinks today (EntityRenderer.setClipPose /
 * AudioManager loop control) since neither needs new GPU/shader plumbing.
 */

export type FxAxis = 'x' | 'y' | 'z';
export type FxRate = number | 'velocity';
export type FxRateScale = number | 'velocity' | 'health' | '1-health';

export interface UvScrollBinding {
    type: 'uvScroll';
    material: string;
    rate: FxRate;
    when?: string;
}

export interface PieceSpinBinding {
    type: 'pieceSpin';
    piece: string;
    axis: FxAxis;
    rate: FxRate;
    when?: string;
}

export interface LoopSoundBinding {
    type: 'loopSound';
    sound: string;
    when?: string;
    attach?: string;
    volume?: number;
}

export interface EmitterBinding {
    type: 'emitter';
    effect: string;
    when?: string;
    attach?: string;
    rateScale?: FxRateScale;
}

export interface OnEventBinding {
    type: 'onEvent';
    event: string;
    effect?: string;
    attach?: string;
    sound?: string;
    anim?: string;
}

export type FxBinding =
    | UvScrollBinding
    | PieceSpinBinding
    | LoopSoundBinding
    | EmitterBinding
    | OnEventBinding;

export interface FxBindingSet {
    def: string;
    bindings: Record<string, FxBinding>;
}

/** Per-entity-per-frame state the condition vocabulary (`when`) reads.
 *  Callers derive this from whatever live state they have (entity stream,
 *  animation state machine, etc.) — this module doesn't know where it
 *  comes from. */
export interface FxEntityState {
    /** Game-defined animation-state label (e.g. "IDLE", "MOVING"). Compared
     *  literally against bare `when` tokens that aren't a recognized form. */
    animState: string;
    /** 0..1 fraction of max health. */
    health: number;
    /** Scalar ground speed, elmos/sec. */
    velocity: number;
    /** Piece names currently rotating fast enough to count as "servo-active"
     *  (caller-defined threshold) — backs `pieceRotating:<name>`. */
    rotatingPieces: ReadonlySet<string>;
}

export interface FxEntityFrame {
    id: number;
    defId: string;
    state: FxEntityState;
}

/** Evaluate one `when` condition. Undefined = always true. Recognized forms:
 *    "health<N" / "health>N", "velocity<N" / "velocity>N",
 *    "pieceRotating:<name>", or a bare token compared against `animState`
 *    (the catch-all — anim-state vocabulary is game-defined, so any other
 *    string is accepted as a literal label, not rejected). */
export function evalWhen(when: string | undefined, state: FxEntityState): boolean {
    if (!when) return true;
    if (when.startsWith('pieceRotating:')) {
        return state.rotatingPieces.has(when.slice('pieceRotating:'.length));
    }
    const health = /^health([<>])([\d.]+)$/.exec(when);
    if (health) {
        return health[1] === '<' ? state.health < Number(health[2]) : state.health > Number(health[2]);
    }
    const velocity = /^velocity([<>])([\d.]+)$/.exec(when);
    if (velocity) {
        return velocity[1] === '<' ? state.velocity < Number(velocity[2]) : state.velocity > Number(velocity[2]);
    }
    return state.animState === when;
}

/** Resolve a `rate` field to a scalar for this frame. */
export function resolveRate(rate: FxRate, state: FxEntityState): number {
    return rate === 'velocity' ? state.velocity : rate;
}

/** Resolve a `rateScale` field to a scalar for this frame. */
export function resolveRateScale(rateScale: FxRateScale | undefined, state: FxEntityState): number {
    if (rateScale === undefined) return 1;
    if (typeof rateScale === 'number') return rateScale;
    if (rateScale === 'velocity') return state.velocity;
    if (rateScale === 'health') return state.health;
    return 1 - state.health; // '1-health'
}

// ============================================================
// Loader
// ============================================================

function fail(defName: string, bindingName: string, msg: string): never {
    throw new Error(`fx-bindings: ${defName}.${bindingName}: ${msg}`);
}

function reqString(obj: Record<string, unknown>, key: string, defName: string, bindingName: string): string {
    const v = obj[key];
    if (typeof v !== 'string' || !v) fail(defName, bindingName, `missing required string "${key}"`);
    return v as string;
}

function optString(obj: Record<string, unknown>, key: string): string | undefined {
    const v = obj[key];
    return typeof v === 'string' ? v : undefined;
}

function optNumber(obj: Record<string, unknown>, key: string): number | undefined {
    const v = obj[key];
    return typeof v === 'number' ? v : undefined;
}

function parseRate(obj: Record<string, unknown>, defName: string, bindingName: string): FxRate {
    const v = obj.rate;
    if (v === 'velocity') return 'velocity';
    if (typeof v === 'number') return v;
    fail(defName, bindingName, `"rate" must be a number or "velocity", got ${JSON.stringify(v)}`);
}

function parseRateScale(obj: Record<string, unknown>, defName: string, bindingName: string): FxRateScale | undefined {
    const v = obj.rateScale;
    if (v === undefined) return undefined;
    if (typeof v === 'number' || v === 'velocity' || v === 'health' || v === '1-health') return v;
    fail(defName, bindingName, `"rateScale" not recognized: ${JSON.stringify(v)} — not a language (PLAN-fx-offload §2); express anything else as an event script`);
}

function parseAxis(obj: Record<string, unknown>, defName: string, bindingName: string): FxAxis {
    const v = obj.axis;
    if (v === 'x' || v === 'y' || v === 'z') return v;
    fail(defName, bindingName, `"axis" must be x/y/z, got ${JSON.stringify(v)}`);
}

function parseBinding(defName: string, bindingName: string, raw: unknown): FxBinding {
    if (typeof raw !== 'object' || raw === null) fail(defName, bindingName, 'must be an object');
    const b = raw as Record<string, unknown>;
    switch (b.type) {
        case 'uvScroll':
            return {
                type: 'uvScroll',
                material: reqString(b, 'material', defName, bindingName),
                rate: parseRate(b, defName, bindingName),
                when: optString(b, 'when'),
            };
        case 'pieceSpin':
            return {
                type: 'pieceSpin',
                piece: reqString(b, 'piece', defName, bindingName),
                axis: parseAxis(b, defName, bindingName),
                rate: parseRate(b, defName, bindingName),
                when: optString(b, 'when'),
            };
        case 'loopSound':
            return {
                type: 'loopSound',
                sound: reqString(b, 'sound', defName, bindingName),
                when: optString(b, 'when'),
                attach: optString(b, 'attach'),
                volume: optNumber(b, 'volume'),
            };
        case 'emitter':
            return {
                type: 'emitter',
                effect: reqString(b, 'effect', defName, bindingName),
                when: optString(b, 'when'),
                attach: optString(b, 'attach'),
                rateScale: parseRateScale(b, defName, bindingName),
            };
        case 'onEvent':
            return {
                type: 'onEvent',
                event: reqString(b, 'event', defName, bindingName),
                effect: optString(b, 'effect'),
                attach: optString(b, 'attach'),
                sound: optString(b, 'sound'),
                anim: optString(b, 'anim'),
            };
        default:
            fail(defName, bindingName, `unknown binding type ${JSON.stringify(b.type)} — the condition/binding vocabulary is deliberately small (PLAN-fx-offload §2); express anything it can't say as an event script, not a new escape hatch here`);
    }
}

/** Parse one def's binding table — the same shape whether it arrived as
 *  JSON (`JSON.parse`) or a Lua table already marshalled to a plain JS
 *  object (see ARCHITECTURE.md "luaTable() marshalling"). Throws loudly on
 *  any malformed/unrecognized binding rather than silently dropping it. */
export function parseBindingSet(raw: unknown): FxBindingSet {
    if (typeof raw !== 'object' || raw === null) throw new Error('fx-bindings: binding set must be an object');
    const obj = raw as Record<string, unknown>;
    if (typeof obj.def !== 'string' || !obj.def) throw new Error('fx-bindings: binding set missing "def" string');
    if (typeof obj.bindings !== 'object' || obj.bindings === null) {
        throw new Error(`fx-bindings: def "${obj.def}" missing "bindings" object`);
    }
    const bindingsRaw = obj.bindings as Record<string, unknown>;
    const bindings: Record<string, FxBinding> = {};
    for (const name of Object.keys(bindingsRaw)) {
        bindings[name] = parseBinding(obj.def, name, bindingsRaw[name]);
    }
    return { def: obj.def, bindings };
}

// ============================================================
// Sinks
// ============================================================

/** Everything the interpreter can cause to happen. Injected so this module
 *  never imports a renderer/audio type directly. */
export interface FxSinks {
    /** FIDELITY-STANDIN sink until X2 lands (see file header). */
    uvScroll(entityId: number, defId: string, binding: UvScrollBinding, rate: number): void;
    pieceSpin(entityId: number, defId: string, binding: PieceSpinBinding, rate: number, dt: number): void;
    /** Called once on the false→true transition — set up the audio graph
     *  node (expensive-ish; not a per-frame call). */
    loopSoundStart(key: string, entityId: number, defId: string, binding: LoopSoundBinding): void;
    /** Called every frame the condition holds, start frame included — the
     *  cheap per-frame part (reposition an already-running voice). */
    loopSoundUpdate(key: string, entityId: number, defId: string, binding: LoopSoundBinding): void;
    /** Called once on the true→false transition, after hysteresis. */
    loopSoundStop(key: string): void;
    /** FIDELITY-STANDIN sink until X3 lands (see file header). */
    emitter(entityId: number, defId: string, binding: EmitterBinding, rateScale: number): void;
    event(entityId: number, defId: string, binding: OnEventBinding): void;
}

/** Warn-once stub for a binding type with no visual sink yet. Conditions
 *  still evaluate (deletes the per-frame script cost); nothing renders. */
function stubOnce(kind: string, planItem: string): (defId: string, name: string) => void {
    const warned = new Set<string>();
    return (defId, name) => {
        const key = `${defId}:${name}`;
        if (warned.has(key)) return;
        warned.add(key);
        console.warn(
            `fx-bindings: "${name}" (${kind}) on def "${defId}" has no ${kind} sink yet — ` +
            `${planItem} is evidence-gated (PLAN-perf N5), not built this session. ` +
            `Binding still evaluates; nothing renders until then.`,
        );
    };
}

/** Default sinks for the two binding types with no faithful render path
 *  yet (see file header FIDELITY-STANDIN). Real callers pass these for
 *  `uvScroll`/`emitter` until X2/X3 land, and their own sinks for
 *  `pieceSpin`/`loopSound`/`event`. */
export function createStubSinks(): Pick<FxSinks, 'uvScroll' | 'emitter'> {
    const warnUvScroll = stubOnce('uvScroll', 'PLAN-fx-offload X2 (per-instance shader UV scroll)');
    const warnEmitter = stubOnce('emitter', 'PLAN-fx-offload X3 (GPU particle pool)');
    return {
        uvScroll: (_id, defId, binding) => warnUvScroll(defId, binding.material),
        emitter: (_id, defId, binding) => warnEmitter(defId, binding.effect),
    };
}

// ============================================================
// Interpreter
// ============================================================

/** Loop-sound hysteresis: a `when` condition (typically `pieceRotating:x`)
 *  must read false for this many consecutive evaluated frames before the
 *  loop actually stops. Absorbs single-frame flicker (e.g. a turret servo
 *  crossing its rotation threshold right at the edge) without audible
 *  start/stop thrash. ~0.27s at 30Hz. */
const LOOP_STOP_HYSTERESIS_FRAMES = 8;

/** Upper bound on bindings per def, used to pack (entityId, bindingIndex)
 *  into one numeric Map key so steady-state loop-sound bookkeeping never
 *  allocates a string. A def with more distinct bindings than this throws
 *  at registerDef() time rather than silently colliding keys. */
const MAX_BINDINGS_PER_DEF = 64;

interface CompiledBinding {
    name: string;
    index: number;
    binding: FxBinding;
}

interface CompiledDef {
    bindings: CompiledBinding[];
}

interface LoopState {
    active: boolean;
    falseStreak: number;
    /** Computed once when this state is created — reused every frame so
     *  the steady-state (already-active, no transition) path never
     *  allocates a string. */
    key: string;
}

export class FxBindingInterpreter {
    private readonly compiled = new Map<string, CompiledDef>();
    private readonly loopStates = new Map<number, LoopState>();

    /** Compile a parsed binding set for lookup by `defId` in evaluate().
     *  Called once per def at content-load time, not per frame. */
    registerDef(set: FxBindingSet): void {
        const bindings: CompiledBinding[] = [];
        let index = 0;
        for (const name of Object.keys(set.bindings)) {
            if (index >= MAX_BINDINGS_PER_DEF) {
                throw new Error(`fx-bindings: def "${set.def}" has more than ${MAX_BINDINGS_PER_DEF} bindings`);
            }
            bindings.push({ name, index, binding: set.bindings[name] });
            index++;
        }
        this.compiled.set(set.def, { bindings });
    }

    unregisterDef(defId: string): void {
        this.compiled.delete(defId);
    }

    hasDef(defId: string): boolean {
        return this.compiled.has(defId);
    }

    /** Test/debug hook: current loop-sound bookkeeping size. In steady
     *  state (no start/stop transitions) this must stay constant across
     *  frames — growth would mean evaluate() is leaking state instead of
     *  reusing it, the deterministic half of the "allocation-free" claim
     *  in §11 (the other half, JS heap growth, is a noisier proxy). */
    debugLoopStateCount(): number {
        return this.loopStates.size;
    }

    /** Drop any loop-sound bookkeeping for an entity that's gone (died,
     *  left LOS). Callers should also have issued a `loopSoundStop` via
     *  their own teardown — this only clears the interpreter's tracking so
     *  a reused entity id doesn't inherit stale hysteresis state. */
    forgetEntity(entityId: number, defId: string): void {
        const compiled = this.compiled.get(defId);
        if (!compiled) return;
        for (const cb of compiled.bindings) {
            this.loopStates.delete(loopStateKey(entityId, cb.index));
        }
    }

    /** One evaluation pass over every supplied entity frame — the whole
     *  per-frame FX-binding cost. No entity without a registered def costs
     *  anything beyond the one Map lookup. Allocation-free in steady state
     *  (no loop start/stop transition this frame). */
    evaluate(entities: readonly FxEntityFrame[], dt: number, sinks: FxSinks): void {
        for (let i = 0; i < entities.length; i++) {
            const ef = entities[i];
            const compiled = this.compiled.get(ef.defId);
            if (!compiled) continue;
            const bindings = compiled.bindings;
            for (let b = 0; b < bindings.length; b++) {
                this.evalOne(ef, bindings[b], dt, sinks);
            }
        }
    }

    private evalOne(ef: FxEntityFrame, cb: CompiledBinding, dt: number, sinks: FxSinks): void {
        const binding = cb.binding;
        switch (binding.type) {
            case 'uvScroll': {
                if (!evalWhen(binding.when, ef.state)) return;
                sinks.uvScroll(ef.id, ef.defId, binding, resolveRate(binding.rate, ef.state));
                return;
            }
            case 'pieceSpin': {
                if (!evalWhen(binding.when, ef.state)) return;
                sinks.pieceSpin(ef.id, ef.defId, binding, resolveRate(binding.rate, ef.state), dt);
                return;
            }
            case 'loopSound': {
                this.evalLoopSound(ef, cb, binding, sinks);
                return;
            }
            case 'emitter': {
                if (!evalWhen(binding.when, ef.state)) return;
                sinks.emitter(ef.id, ef.defId, binding, resolveRateScale(binding.rateScale, ef.state));
                return;
            }
            case 'onEvent':
                return; // event-rate only — see fireEvent()
        }
    }

    private evalLoopSound(ef: FxEntityFrame, cb: CompiledBinding, binding: LoopSoundBinding, sinks: FxSinks): void {
        const key = loopStateKey(ef.id, cb.index);
        const cond = evalWhen(binding.when, ef.state);
        let ls = this.loopStates.get(key);
        if (cond) {
            if (!ls) {
                ls = { active: false, falseStreak: 0, key: loopSoundKey(ef.id, cb.name) };
                this.loopStates.set(key, ls);
            }
            ls.falseStreak = 0;
            if (!ls.active) {
                ls.active = true;
                sinks.loopSoundStart(ls.key, ef.id, ef.defId, binding);
            }
            sinks.loopSoundUpdate(ls.key, ef.id, ef.defId, binding);
        } else if (ls?.active) {
            ls.falseStreak++;
            if (ls.falseStreak >= LOOP_STOP_HYSTERESIS_FRAMES) {
                ls.active = false;
                sinks.loopSoundStop(ls.key);
            }
        }
    }

    /** Fire an `onEvent` binding for `eventName` on `defId`, if one exists.
     *  Event-rate only — callers invoke this from wherever the real event
     *  already fires (weapon-fired dispatch, death handling), not from the
     *  per-frame evaluate() pass. */
    fireEvent(entityId: number, defId: string, eventName: string, sinks: Pick<FxSinks, 'event'>): void {
        const compiled = this.compiled.get(defId);
        if (!compiled) return;
        for (const cb of compiled.bindings) {
            if (cb.binding.type === 'onEvent' && cb.binding.event === eventName) {
                sinks.event(entityId, defId, cb.binding);
            }
        }
    }
}

function loopStateKey(entityId: number, bindingIndex: number): number {
    return entityId * MAX_BINDINGS_PER_DEF + bindingIndex;
}

/** String key for the audio-side handle — only allocated on an actual
 *  start/stop transition (evalLoopSound short-circuits every other frame),
 *  so this never runs in the allocation-free steady-state path. */
function loopSoundKey(entityId: number, bindingName: string): string {
    return `${entityId}:${bindingName}`;
}
