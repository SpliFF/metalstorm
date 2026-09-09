-- lib/authority.lua — authority-cost PREVIEW for AI players.
--
-- An AI pays authority like a human (design law), and it cannot call the
-- charge callin to ask "what would this cost?" — so it predicts. The prediction
-- must be the SAME arithmetic the sim runs, or the AI's budget governor
-- silently drifts from what it is actually charged (which is exactly what
-- happened to ai/strategos/config.lua's hand-copied table: it prices an
-- area-scoped directive at Σstrength × 0.5 when the sim charges a flat 2 —
-- see docs/reviews/2026-09-10/ai-framework.md F1).
--
-- SOURCE OF TRUTH, in preference order:
--   1. `AI.getDefExport('authority_cost.json')` — the versioned JSON export
--      authority ask A3 plans to bake into the def cache dir (feature-detected;
--      NOT written by the server today — proposal P2 in docs/ai-players.md).
--   2. lib/vendor/authority_cost.lua + lib/vendor/formula.lua — byte-identical
--      copies of the synced originals, guarded by lib/tests/vendor_drift_spec.
-- Neither path duplicates a constant by hand: the table is the original's
-- bytes and the formula is the original's function.
--
-- WHAT THE SIM ACTUALLY CHARGES AN AI (game_authority.lua ChargeDirective,
-- reached from the AI drain through the SAME AllowDirectiveCreate a human hits):
--   * area-scoped directive (groupHandle 0)  → base 1, class 'standing'
--   * group-scoped directive (real group)     → base Σ authority_cost_base over
--                                               the LIVE roster, class 'directive'
--   * regionMod is PINNED to 1.0 for directives (scoped simplification, called
--     out in the gadget; the client preview does the same)
--   * createGroup / setPosture / sendMessage  → no charge callin on the AI drain
--   cost = ceil(base_k × base × regionMod × classMod × costScale); costScale 0 ⇒ 0.

local Engine  = require('lib.engine')
local Formula = require('lib.vendor.formula')

local Authority = {}

local spec       = nil     -- the cost spec in use
local specSource = 'none'  -- 'export' | 'vendor'

local function vendorSpec()
    return require('lib.vendor.authority_cost')
end

--- Load (or reload) the cost spec. Prefers the JSON export when the runtime
-- has it; falls back to the vendored copy. Returns the spec and its source.
function Authority.load()
    local exported = Engine.defExport('authority_cost.json')
    if type(exported) == 'table' and type(exported.order_class) == 'table'
            and tonumber(exported.base_k) then
        spec, specSource = exported, 'export'
    else
        spec, specSource = vendorSpec(), 'vendor'
    end
    return spec, specSource
end

function Authority.spec()
    if not spec then Authority.load() end
    return spec
end

function Authority.source()
    if not spec then Authority.load() end
    return specSource
end

--- Live cost scale (modoption mirrored as a public game rulesParam by
-- game_authority.lua). 1.0 when the mirror is absent. 0 means free orders.
function Authority.costScale()
    local v = Engine.rulesNumber('game', 'authority_cost_scale')
    if v == nil then return 1.0 end
    return v
end

--- Does the live game publish a cost-spec version that differs from ours?
-- nil = the game publishes none (cannot tell); true = mismatch (predictions
-- may be wrong — a caller should widen its margins or stop predicting).
function Authority.versionMismatch()
    local live = Engine.rulesNumber('game', 'authority_cost_version')
    if live == nil then return nil end
    return live ~= (Authority.spec().version or 0)
end

--- The formula itself, exposed so callers never re-implement it.
function Authority.cost(base, class, costScale, regionMod)
    local s = Authority.spec()
    local classMod = (s.order_class or {})[class] or 1.0
    return Formula.cost(s.base_k or 1.0, base or 1, regionMod or 1.0, classMod,
                        costScale == nil and Authority.costScale() or costScale)
end

--- Predict a directive create charge.
-- opts: { scope = 'area' | 'group', baseSum = Σ authority_cost_base (group
-- scope only), costScale = override, regionMod = override (sim pins 1.0) }
function Authority.directiveCost(opts)
    opts = opts or {}
    if opts.scope == 'group' then
        return Authority.cost(opts.baseSum or 0, 'directive', opts.costScale, opts.regionMod or 1.0)
    end
    return Authority.cost(1, 'standing', opts.costScale, opts.regionMod or 1.0)
end

--- Posture changes, group creates and messages have no charge callin on the
-- AI drain today (StateStreamer::ApplyAICommands). Kept as functions so a
-- future charge lands in one place.
function Authority.postureCost() return 0 end
function Authority.groupCost()   return 0 end
function Authority.messageCost() return 0 end

--- Per-def base cost, from a power.json entry. The export carries no
-- `authority_cost_base` field (gap G5); units/_builder.lua derives the base
-- from the def's scale unless a def overrides it, so `scale` is the honest
-- approximation and is flagged as such by the second return.
function Authority.unitBase(powerEntry)
    if type(powerEntry) == 'table' then
        local explicit = tonumber(powerEntry.authority_cost_base)
        if explicit then return explicit, true end
        local scale = tonumber(powerEntry.scale)
        if scale and scale > 0 then return scale, false end
    end
    return 1, false     -- the gadget's own "missing/unresolved → 1" fallback
end

--- Σ base over a list of units ({defId=...}) priced via a power table.
function Authority.baseSum(units, power)
    local sum = 0
    for _, u in ipairs(units or {}) do
        sum = sum + Authority.unitBase(power and power[u.defId])
    end
    return sum
end

--- Test hook: force a spec (or nil to re-detect on next use).
function Authority._setSpec(s, source)
    spec, specSource = s, source or 'test'
end

return Authority
