/**
 * cost-preview.ts — command composer cost preview + Subject two-way sync
 * (PLAN-metalstorm-scripting.md task 5, task 4's Subject prefill).
 *
 * Pure logic only — no DOM, no imports of the actual authority-cost.js /
 * regions.js game modules (those are game-authored files served over HTTP
 * from `data/games/metalstorm/ui/lib/`, fetched at runtime via dynamic
 * `import()` by the widget itself — see command-composer.js). `CostModelLike`
 * duck-types their shape so this module stays testable without a fetch.
 *
 * SCOPED SIMPLIFICATION (documented per CLAUDE.md "never deviate from Recoil
 * silently"): the sim has **no directive-create charge site at all yet** —
 * verified against `rts/Server/ClientMessageHandler.cpp`'s GroupDirective
 * handler and `game_authority_charge.lua` (only per-unit `AllowCommand`
 * orders are charged; `GG.Authority.ChargeDirective` doesn't exist —
 * PLAN-metalstorm-authority.md task 8, Stage-7-gated). This preview predicts
 * what that charge *would* be using the shipped formula/spec (real data:
 * `authority_cost.json`, live pool rulesParams, and a real Σ member
 * `authority_cost_base` computed worker-side — see game-processor.ts
 * `gpComputeGroupBaseCost`), with two inputs pinned to their neutral default
 * rather than invented: `regionMod = 1.0` (no client-side region-index load
 * wired in this pass — the plan's own §4 "accepted divergence" already
 * tolerates a stale regionMod) and `costScale = 1.0` (modoptions aren't
 * streamed to the client yet). Both are real formula inputs, not fabricated
 * data — they're just not live-tracked here yet.
 */

export type Echelon = 'Squad' | 'Platoon' | 'Army';

export interface CostModelLike {
    predict(p: { baseCost: number; orderClassKey: string; regionMod: number; costScale: number }): number | null;
    canAfford(cost: number, playerPool: number, teamPool: number): boolean;
}

export interface OrgGroupLike {
    groupId: number;
    echelon: Echelon;
    memberIds: number[];
    baseCostSum: number;
}

export interface CostPreview {
    cost: number;
    affordable: boolean;
    /** 0 when affordable; otherwise how much more authority is needed. */
    shortfall: number;
}

/** Order-class key for a group-scoped directive create, by echelon
 *  (PLAN-metalstorm-authority.md §3.3: platoon directives amortise more
 *  than army ones). Metalstorm v0 only ships two echelons (squad +
 *  platoon/group — PLAN-macro-orders.md); 'Squad' groups fall back to the
 *  same 'group_op' rate as 'Platoon' since a squad-echelon directive is the
 *  same shape of spend, just smaller. */
export function orderClassForEchelon(echelon: Echelon): 'directive' | 'group_op' {
    return echelon === 'Army' ? 'directive' : 'group_op';
}

/**
 * Preview the authority cost of committing `compiled` (a compile-table.ts
 * `CompiledMessage`). Returns null when there is nothing to predict:
 *   - not a GroupDirective (StandingOrder/AIGuidance have no charge site at
 *     all today — §3.2's table only charges direct player commands, and
 *     AIGuidance is advisory, never a spend);
 *   - no matching org group (subject wasn't a fixed roster — idle-filter
 *     subjects have no roster until the sim assigns squads, so there's
 *     nothing to sum a base cost over);
 *   - the cost model has no spec loaded (network hasn't fetched
 *     authority_cost.json yet).
 */
export function previewDirectiveCost(
    compiledType: string,
    group: OrgGroupLike | null,
    costModel: CostModelLike,
    playerPool: number,
    teamPool: number,
): CostPreview | null {
    if (compiledType !== 'GroupDirective' || !group) return null;
    const orderClassKey = orderClassForEchelon(group.echelon);
    const cost = costModel.predict({
        baseCost: group.baseCostSum,
        orderClassKey,
        regionMod: 1.0,
        costScale: 1.0,
    });
    if (cost === null) return null;
    const affordable = costModel.canAfford(cost, playerPool, teamPool);
    return {
        cost,
        affordable,
        shortfall: affordable ? 0 : cost - (playerPool + teamPool),
    };
}

/**
 * Find the org group whose current roster exactly matches the world
 * selection (PLAN-metalstorm-scripting.md §3: "selecting a group on the map
 * pre-fills the Subject"). Exact-set match only, by design: a partial
 * overlap is ambiguous (which group did the player mean — this one, or a
 * superset/subset of it?), so it intentionally returns null rather than
 * guessing wrong and silently steering an order at the wrong roster.
 */
export function matchSelectionToGroup(
    selectedUnitIds: readonly number[],
    groups: readonly OrgGroupLike[],
): number | null {
    if (selectedUnitIds.length === 0) return null;
    const selected = new Set(selectedUnitIds);
    for (const g of groups) {
        if (g.memberIds.length !== selected.size) continue;
        if (g.memberIds.every((id) => selected.has(id))) return g.groupId;
    }
    return null;
}
