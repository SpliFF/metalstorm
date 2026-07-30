/**
 * PLAN-fx-offload X5 — the Fengari fence for legacy per-frame entity FX
 * scripts (§7, §10 task 2).
 *
 * fx-bindings.ts (X4) is the declarative replacement for per-frame entity
 * `onUpdate` scripts. ZK/BAR content that still ships an actual per-frame
 * Lua/JS callback keeps working — faithfully, per AGENTS.md — but only
 * through this compatibility path, which bounds its cost three ways
 * (§7's compatibility bullet):
 *   (a) LOD-gated to near-camera entities (same distance tiers
 *       PLAN-client-entity.md §Performance already specifies: full inside
 *       500 elmos, half-rate 500-2000, no execution beyond 2000),
 *   (b) hard-capped by the combined Lua+JS script budget (PLAN-scripting.md:
 *       3-5ms/frame) — once the frame's share is spent, further calls are
 *       skipped rather than let the frame run long,
 *   (c) console-warned once per def ("consider bindings").
 *
 * Per-def cost/skip counts are exposed via dump() for the same debug-
 * console surface uiProfileDump() already serves (PLAN-perf N1) — see
 * `entityFxFenceDump` in game-processor.ts.
 *
 * There is no live per-frame entity-script dispatch to wrap yet (confirmed
 * while researching this task — see PLAN-fx-offload field notes): this
 * fence is the ready-to-use gate for whichever module ends up calling
 * legacy per-def `onUpdate` closures once one exists (PLAN-fx-offload task
 * 3, the JS animation system, is the next in line to need it). Until then
 * it's exercised directly by entity-fx-fence.test.ts.
 */

/** Faithful to PLAN-client-entity.md §Performance Considerations' LOD
 *  table: below this distance every legacy script runs at full rate. */
export const FENCE_LOD_CLOSE_ELMOS = 500;
/** At/above this distance, legacy scripts never run at all (default
 *  animation only, per the same table's "Far" tier). Between the two
 *  tiers scripts run at half rate ("Medium"). */
export const FENCE_LOD_FAR_ELMOS = 2000;

/** PLAN-scripting.md's combined Lua+JS per-frame script budget is
 *  3-5ms; this is the entity-FX compatibility path's share of it. */
export const DEFAULT_FRAME_BUDGET_MS = 4;

export type FenceLod = "full" | "half" | "skip";

export function lodForDistance(distanceToCamera: number): FenceLod {
  if (distanceToCamera < FENCE_LOD_CLOSE_ELMOS) return "full";
  if (distanceToCamera < FENCE_LOD_FAR_ELMOS) return "half";
  return "skip";
}

interface PerDefStats {
  ms: number;
  calls: number;
  skippedLod: number;
  skippedBudget: number;
  warned: boolean;
}

export interface EntityFxFenceDefRow {
  def: string;
  ms: number;
  calls: number;
  avgMs: number;
  skippedLod: number;
  skippedBudget: number;
}

export interface EntityFxFenceDump {
  frames: number;
  /** Ranked most-expensive-first, matching uiProfileDump()'s convention. */
  perDef: EntityFxFenceDefRow[];
}

/**
 * The fence itself. One instance covers every def's legacy per-frame FX
 * callback; `beginFrame()` resets the per-frame budget, `run()` wraps one
 * def's callback for one entity this frame.
 */
export class EntityFxFence {
  private readonly stats = new Map<string, PerDefStats>();
  /** Half-rate LOD alternates per entity so "every other frame" doesn't
   *  synchronize across the whole visible set (which would just move
   *  the cost spike to alternating frames instead of spreading it). */
  private readonly halfRateParity = new Map<number, boolean>();
  private frameCount = 0;
  private budgetRemainingMs: number;

  constructor(
    private readonly frameBudgetMs: number = DEFAULT_FRAME_BUDGET_MS,
  ) {
    this.budgetRemainingMs = frameBudgetMs;
  }

  /** Call once per render frame, before any run() calls for that frame. */
  beginFrame(): void {
    this.frameCount++;
    this.budgetRemainingMs = this.frameBudgetMs;
  }

  /** Drop LOD-parity bookkeeping for an entity that's gone. Not required
   *  for correctness (a stale entry just never gets read again) — keeps
   *  the map from growing across a long session's full entity churn. */
  forgetEntity(entityId: number): void {
    this.halfRateParity.delete(entityId);
  }

  private statsFor(defName: string): PerDefStats {
    let s = this.stats.get(defName);
    if (!s) {
      s = { ms: 0, calls: 0, skippedLod: 0, skippedBudget: 0, warned: false };
      this.stats.set(defName, s);
    }
    return s;
  }

  /**
   * Run one legacy per-frame entity-script callback for one entity,
   * subject to the LOD gate then the frame budget cap. Returns whether
   * `fn` actually ran. `now` is injectable for tests; defaults to
   * `performance.now`.
   */
  run(
    defName: string,
    entityId: number,
    distanceToCamera: number,
    fn: () => void,
    now: () => number = () => performance.now(),
  ): boolean {
    const s = this.statsFor(defName);
    if (!s.warned) {
      s.warned = true;
      console.warn(
        `entity-fx-fence: def "${defName}" runs a per-frame script FX callback — ` +
          `consider a PLAN-fx-offload binding (client/units/${defName}/bindings.json) instead.`,
      );
    }

    const lod = lodForDistance(distanceToCamera);
    if (lod === "skip") {
      s.skippedLod++;
      return false;
    }
    if (lod === "half") {
      const runThisFrame = !(this.halfRateParity.get(entityId) ?? false);
      this.halfRateParity.set(entityId, runThisFrame);
      if (!runThisFrame) {
        s.skippedLod++;
        return false;
      }
    }

    if (this.budgetRemainingMs <= 0) {
      s.skippedBudget++;
      return false;
    }

    const t0 = now();
    fn();
    const elapsed = now() - t0;
    this.budgetRemainingMs -= elapsed;
    s.ms += elapsed;
    s.calls++;
    return true;
  }

  dump(): EntityFxFenceDump {
    const perDef: EntityFxFenceDefRow[] = [];
    for (const [def, s] of this.stats) {
      perDef.push({
        def,
        ms: s.ms,
        calls: s.calls,
        avgMs: s.calls > 0 ? s.ms / s.calls : 0,
        skippedLod: s.skippedLod,
        skippedBudget: s.skippedBudget,
      });
    }
    perDef.sort((a, b) => b.ms - a.ms);
    return { frames: this.frameCount, perDef };
  }

  reset(): void {
    this.stats.clear();
    this.halfRateParity.clear();
    this.frameCount = 0;
    this.budgetRemainingMs = this.frameBudgetMs;
  }
}
