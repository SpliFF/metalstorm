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
 * Mirrors the SERVER charge formula exactly (game_authority.lua
 * GG.Authority.ChargeDirective/ChargeStandingOrder, wired to the engine's
 * AllowDirectiveCreate/AllowStandingOrderCreate callins —
 * PLAN-metalstorm-authority.md §3.2/A2, PLAN-macro-directives.md §1):
 *   - GroupDirective with a resolved org group → Σ member
 *     authority_cost_base (real data: a real Σ computed worker-side, see
 *     game-processor.ts `gpComputeGroupBaseCost`) under the 'directive'
 *     order class, regardless of echelon (v0 only ever creates
 *     platoon-echelon groups — PLAN-macro-directives.md §1 field
 *     discipline — so there is no echelon-differentiated rate today).
 *   - GroupDirective with no group (condition/area-scoped — the "classic
 *     standing order" shape sent over the unified GroupDirective wire) and
 *     StandingOrder messages both charge a flat base=1 fee under the
 *     'standing' order class — there is no fixed roster at create time to
 *     sum a base cost over.
 *   - AIGuidance has no charge site (advisory, never a spend — AI's own
 *     budget governance lives in ai/strategos, PLAN-metalstorm-ai.md §3.2).
 *
 * SCOPED SIMPLIFICATION (documented per CLAUDE.md "never deviate from Recoil
 * silently"): two inputs are pinned to their neutral default, matching the
 * exact same simplification the server-side charge makes (so client preview
 * and server charge stay in lockstep — the actual requirement, not perfect
 * prediction): `regionMod = 1.0` (a directive has no single position to look
 * up a region modifier from — see game_authority.lua's ChargeDirective doc
 * comment) and `costScale = 1.0` (modoptions aren't streamed to the client
 * yet).
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

/**
 * Preview the authority cost of committing `compiled` (a compile-table.ts
 * `CompiledMessage`). Returns null when there is nothing to predict:
 *   - AIGuidance (never a spend, see module doc);
 *   - the cost model has no spec loaded for the resolved order class
 *     (network hasn't fetched authority_cost.json yet).
 */
export function previewDirectiveCost(
    compiledType: string,
    group: OrgGroupLike | null,
    costModel: CostModelLike,
    playerPool: number,
    teamPool: number,
): CostPreview | null {
    if (compiledType !== 'GroupDirective' && compiledType !== 'StandingOrder') return null;
    const hasGroup = compiledType === 'GroupDirective' && group !== null;
    const orderClassKey = hasGroup ? 'directive' : 'standing';
    const baseCost = hasGroup ? (group as OrgGroupLike).baseCostSum : 1;
    const cost = costModel.predict({
        baseCost,
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
