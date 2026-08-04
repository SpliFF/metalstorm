-- tests/lod_spec.lua — dynamic LOD (PLAN-metalstorm-ai.md §5 NPC column,
-- PLAN-ai.md "AI LOD System"). Run from the plugin root: busted tests/.
--
-- lod.lua is PURE (it takes a Picture-shaped table), so everything here is a
-- hand-built fixture — no _G.AI mock needed. The graph below is a straight
-- chain so hop counts are unambiguous:
--
--     home ── mid ── far ── deep
--
-- with `home` owned by team 0 and enemy intel planted at whichever node the
-- case is about.

package.path = './?.lua;' .. package.path

local Config = require('config')
local Graph  = require('graph')
local Lod    = require('lod')

local function chainRegions(over)
    local regions = {
        home = { value = 1, neighbors = { 'mid' },          owner = 0 },
        mid  = { value = 1, neighbors = { 'home', 'far' } },
        far  = { value = 1, neighbors = { 'mid', 'deep' } },
        deep = { value = 1, neighbors = { 'far' } },
    }
    for key, patch in pairs(over or {}) do
        for k, v in pairs(patch) do regions[key][k] = v end
    end
    return regions
end

--- Picture with enemy intel at `threatKey` (nil = nothing seen anywhere).
local function picture(threatKey, opts)
    opts = opts or {}
    local intel = {}
    if threatKey then
        intel[threatKey] = { strength = 100, confidence = 1.0 }
    end
    return {
        frame   = opts.frame or 0,
        caps    = opts.caps or {},
        regions = opts.regions or chainRegions(),
        ledger  = opts.ledger or { home = { strength = 50 } },
        intel   = intel,
        lod     = opts.lod,
    }
end

local NPC = { teamId = 0, lodFloor = 0, lodCeil = 3, tickFramesBase = 150 }

--=============================================================================
describe("Graph.hops / minHops", function()
    it("counts hops over region.neighbors, not elmos", function()
        local d = Graph.hops(chainRegions(), { home = true })
        assert.are.equal(0, d.home)
        assert.are.equal(1, d.mid)
        assert.are.equal(2, d.far)
        assert.are.equal(3, d.deep)
    end)

    it("ignores source/target keys the graph does not have", function()
        local d = Graph.hops(chainRegions(), { home = true, nowhere = true })
        assert.is_nil(d.nowhere)
        assert.are.equal(0, d.home)
    end)

    it("returns nil when no target is reachable or the target set is empty", function()
        local regions = chainRegions({ mid = { neighbors = { 'home' } } })  -- cut the chain
        assert.is_nil(Graph.minHops(regions, { home = true }, { deep = true }))
        assert.is_nil(Graph.minHops(regions, { home = true }, {}))
    end)
end)

--=============================================================================
describe("Lod.tierForContact — hops, not elmos (plan §2)", function()
    it("is LOD 0 with contact on ground we occupy", function()
        assert.are.equal(0, Lod.tierForContact(picture('home'), NPC))
    end)

    it("steps out one tier per graph hop", function()
        assert.are.equal(1, Lod.tierForContact(picture('mid'), NPC))
        assert.are.equal(2, Lod.tierForContact(picture('far'), NPC))
    end)

    it("is dormant beyond the last band", function()
        assert.are.equal(Lod.TIER_DORMANT, Lod.tierForContact(picture('deep'), NPC))
    end)

    it("is dormant with nothing seen at all", function()
        assert.are.equal(Lod.TIER_DORMANT, Lod.tierForContact(picture(nil), NPC))
    end)

    it("counts contested OWN ground as contact even with no sighting", function()
        local p = picture(nil, { regions = chainRegions({ home = { contested = true } }) })
        assert.are.equal(0, Lod.tierForContact(p, NPC))
    end)

    it("counts owned ground we hold no force in as ours", function()
        -- Force wiped out, territory still ours: an enemy next door must wake us.
        local p = picture('mid', { ledger = {} })
        assert.are.equal(1, Lod.tierForContact(p, NPC))
    end)

    it("falls back to see/don't-see when no region graph is loaded", function()
        local blind = { regions = {}, ledger = {}, frame = 0 }
        blind.intel = { _all = { strength = 10 } }
        assert.are.equal(0, Lod.tierForContact(blind, NPC))
        blind.intel = {}
        assert.are.equal(Lod.TIER_DORMANT, Lod.tierForContact(blind, NPC))
    end)
end)

--=============================================================================
describe("Lod.evaluate — hysteresis (PLAN-ai.md LOD Transitions)", function()
    it("escalates immediately when contact appears", function()
        local state = Lod.newState(NPC)
        state.tier = Lod.TIER_DORMANT
        assert.are.equal(0, Lod.evaluate(state, picture('home', { frame = 500 }), NPC, Config))
    end)

    it("de-escalates one tier at a time, each after its own dwell", function()
        local state = Lod.newState(NPC)
        -- Start in contact so the tier is 0.
        assert.are.equal(0, Lod.evaluate(state, picture('home', { frame = 0 }), NPC, Config))

        -- Quiet from here on. The dwell clock starts at the FIRST tick that
        -- wants a lower tier (that tick is the observation "we are outside LOD-0
        -- range"), so this one still reports 0 however late it lands.
        assert.are.equal(0, Lod.evaluate(state, picture(nil, { frame = 150 }), NPC, Config))
        -- 149 frames later is still short of the 150-frame LOD-0 dwell...
        assert.are.equal(0, Lod.evaluate(state, picture(nil, { frame = 299 }), NPC, Config))
        assert.are.equal(1, Lod.evaluate(state, picture(nil, { frame = 300 }), NPC, Config))

        -- LOD 1 -> 2 needs 300 frames of continued quiet from the next
        -- observation at this tier.
        assert.are.equal(1, Lod.evaluate(state, picture(nil, { frame = 450 }), NPC, Config))
        assert.are.equal(1, Lod.evaluate(state, picture(nil, { frame = 700 }), NPC, Config))
        assert.are.equal(2, Lod.evaluate(state, picture(nil, { frame = 750 }), NPC, Config))

        -- LOD 2 -> dormant needs 900.
        assert.are.equal(2, Lod.evaluate(state, picture(nil, { frame = 1350 }), NPC, Config))
        assert.are.equal(2, Lod.evaluate(state, picture(nil, { frame = 2000 }), NPC, Config))
        assert.are.equal(3, Lod.evaluate(state, picture(nil, { frame = 2250 }), NPC, Config))
    end)

    it("re-arms the dwell after a contact interrupts the wind-down", function()
        local state = Lod.newState(NPC)
        Lod.evaluate(state, picture('home', { frame = 0 }), NPC, Config)
        Lod.evaluate(state, picture(nil, { frame = 150 }), NPC, Config)   -- clock starts
        -- Contact again: instant escalation, and the pending want is dropped.
        assert.are.equal(0, Lod.evaluate(state, picture('home', { frame = 200 }), NPC, Config))
        assert.is_nil(state.wantSinceFrame)
        -- So the next quiet tick starts a FRESH 150-frame dwell.
        assert.are.equal(0, Lod.evaluate(state, picture(nil, { frame = 250 }), NPC, Config))
        assert.are.equal(0, Lod.evaluate(state, picture(nil, { frame = 399 }), NPC, Config))
        assert.are.equal(1, Lod.evaluate(state, picture(nil, { frame = 400 }), NPC, Config))
    end)

    it("clamps into the role's LOD band — a co-commander never goes quiet", function()
        local coCmdr = { teamId = 0, lodFloor = 0, lodCeil = 0, tickFramesBase = 150 }
        local state = Lod.newState(coCmdr)
        for _, f in ipairs({ 0, 1000, 5000, 20000 }) do
            assert.are.equal(0, Lod.evaluate(state, picture(nil, { frame = f }), coCmdr, Config))
        end
    end)

    it("prefers the engine's tier the moment AI.getLODLevel exists", function()
        local state = Lod.newState(NPC)
        -- The contact proxy would say dormant (nothing seen); the engine says 1,
        -- and it wins immediately — the runtime owns the transition ladder in
        -- that world, so our dwell must not damp it a second time.
        local p = picture(nil, { frame = 0, caps = { lod = true }, lod = 1 })
        assert.are.equal(1, Lod.evaluate(state, p, NPC, Config))
        -- ...and it is still clamped into the role's band.
        local coCmdr = { teamId = 0, lodFloor = 0, lodCeil = 0 }
        assert.are.equal(0, Lod.evaluate(Lod.newState(coCmdr),
            picture(nil, { frame = 0, caps = { lod = true }, lod = 3 }), coCmdr, Config))
    end)
end)

--=============================================================================
describe("Lod.periodFor", function()
    it("scales the base cadence by the tier multiplier", function()
        assert.are.equal(150,  Lod.periodFor(0, NPC, Config))
        assert.are.equal(150,  Lod.periodFor(1, NPC, Config))
        assert.are.equal(600,  Lod.periodFor(2, NPC, Config))
        assert.are.equal(1800, Lod.periodFor(3, NPC, Config))
    end)
end)
