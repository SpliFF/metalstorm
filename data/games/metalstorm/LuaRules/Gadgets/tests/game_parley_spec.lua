-- tests/game_parley_spec.lua — gadget-level behaviour against a mocked
-- Spring/GG (see parley_mock.lua header). PLAN-metalstorm-interaction.md §11.
-- Run from the plugin root: cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

local mock = require('tests.parley_mock')

local function newWorld()
    local world, gadgetObj = mock.new('./game_parley.lua')
    gadgetObj:Initialize()
    world.setPlayer(1, 10)   -- proposer on team 10
    world.setPlayer(2, 20)   -- responder on team 20
    world.setTeamPool(10, 1000)
    world.setTeamPool(20, 1000)
    world.setPlayerPool(1, 1000)
    world.setPlayerPool(2, 1000)
    return world, gadgetObj
end

describe("proposal lifecycle (§1)", function()
    it("offer -> accept activates a ceasefire and charges the propose fee", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        assert.is_number(id)
        assert.are.equal('offered', world.rp('parley_' .. id .. '_state'))
        assert.are.equal(985, world.playerPools[1])   -- 1000 - PROPOSE_FEE(15)

        local ok = GG.Parley.Respond(id, 20, 2, 'accept')
        assert.is_true(ok)
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))
    end)

    it("offer -> reject terminates without activating", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'reject')
        assert.are.equal('rejected', world.rp('parley_' .. id .. '_state'))
    end)

    it("expires unanswered proposals past their deadline", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        world.frame = 100000
        gadgetObj:GameFrame(world.frame)
        assert.are.equal('expired', world.rp('parley_' .. id .. '_state'))
    end)

    it("a counter-offer terminates the ancestor as 'countered' and creates a new reversed proposal", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        local ok = GG.Parley.Respond(id, 20, 2, 'counter', { terms = { duration = 900 } })
        assert.is_true(ok)
        assert.are.equal('countered', world.rp('parley_' .. id .. '_state'))
        -- The new proposal is id+1, reversed direction (20 -> 10).
        local newId = id + 1
        assert.are.equal(20, world.rp('parley_' .. newId .. '_from'))
        assert.are.equal(10, world.rp('parley_' .. newId .. '_to'))
        assert.are.equal(id, world.rp('parley_' .. newId .. '_counterOf'))
    end)
end)

describe("fee + caps + cooldown (E6)", function()
    it("refuses a propose when the proposer can't afford the fee", function()
        local world = newWorld()
        world.setPlayerPool(1, 0)
        world.setTeamPool(10, 0)
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        assert.is_nil(id)
    end)

    it("caps live outgoing proposals per team at 4", function()
        local world = newWorld()
        for i = 1, 4 do
            local id = GG.Parley.Propose(10, 1, 20 + i, 'ceasefire', { duration = 1800 })
            assert.is_number(id)
        end
        local fifth = GG.Parley.Propose(10, 1, 25, 'ceasefire', { duration = 1800 })
        assert.is_nil(fifth)
    end)

    it("enforces a cooldown after a rejection before re-proposing to the same team", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'reject')
        local retry = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        assert.is_nil(retry)
    end)
end)

describe("tribute escrow (§1)", function()
    it("escrows the proposer's stake at propose time and pays out on accept", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'tribute', { amount = 100 })
        assert.are.equal(885, world.playerPools[1])   -- 1000 - fee(15) - stake(100)

        GG.Parley.Respond(id, 20, 2, 'accept')
        assert.are.equal('fulfilled', world.rp('parley_' .. id .. '_state'))
        assert.are.equal(1100, world.authorityPools[20])   -- team 20 received the tribute
    end)

    it("refunds the escrow when a tribute offer is rejected", function()
        local world = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'tribute', { amount = 100 })
        GG.Parley.Respond(id, 20, 2, 'reject')
        assert.are.equal(985, world.playerPools[1])   -- fee spent, stake refunded
    end)

    it("breaches a per-minute tribute pact on a missed payment", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'tribute', { amount = 5000, perMinute = true, duration = 36000 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))

        world.setTeamPool(10, 0)   -- payer can't cover the next instalment
        world.frame = 1800
        gadgetObj:GameFrame(world.frame)
        assert.are.equal('breached', world.rp('parley_' .. id .. '_state'))
    end)
end)

-- endtoend D62. Parley is the caller that proved GG.Authority.ChargeOrder is a
-- generic player-then-team pool debit rather than an order charge, and until it
-- had a `reason` of its own it borrowed the COST-table key as the ACCOUNTING
-- reason. Asserted on the argument parley passes, not on a ledger counter,
-- because the reason is exactly what was missing from the wire between them.
describe("ledger reasons on the charges parley makes (D62)", function()
    local function reasonsIn(world)
        local out = {}
        for _, c in ipairs(world.chargeLog) do out[#out + 1] = c.reason end
        return out
    end

    it("files the §1 spam-guard fee as 'proposal_fee', not an order class", function()
        local world = newWorld()
        assert.is_number(GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 }))
        assert.are.same({ 'proposal_fee' }, reasonsIn(world))
    end)

    it("files a recurring tribute instalment as 'tribute' — a move, not a burn", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'tribute',
                                     { amount = 100, perMinute = true, duration = 36000 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))

        world.frame = 1800
        gadgetObj:GameFrame(world.frame)
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))

        -- The fee, then the instalment. The instalment's payee half is Awarded
        -- as 'tribute' already; this is the payer half that used to file burn.
        assert.are.same({ 'proposal_fee', 'tribute' }, reasonsIn(world))
    end)
end)

describe("ceasefire order-veto matrix (§2)", function()
    it("vetoes an attack on a pact partner's unit, uncharged", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')

        world.setUnit(101, 20, 5, 5, 100)   -- target on team 20
        local allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.ATTACK, { 101 }, {}, nil, 1, false, false)
        assert.is_false(allowed)
    end)

    it("does not veto non-attack orders", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')

        world.setUnit(101, 20, 5, 5, 100)
        local allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.MOVE, { 1, 0, 1 }, {}, nil, 1, false, false)
        assert.is_true(allowed)
    end)

    it("does not veto an attack on a non-partner (enemy outside the pact)", function()
        local world, gadgetObj = newWorld()
        world.setPlayer(3, 30)
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')

        world.setUnit(102, 30, 5, 5, 100)   -- a THIRD team, not party to the pact
        local allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.ATTACK, { 102 }, {}, nil, 1, false, false)
        assert.is_true(allowed)
    end)

    it("scopes veto to the regionKey for a region-scoped ceasefire", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800, regionKey = 'basin_a' })
        GG.Parley.Respond(id, 20, 2, 'accept')

        world.setUnit(101, 20, 5, 5, 100)
        world.setUnitRegion(101, 'basin_b')   -- outside the scoped region
        local allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.ATTACK, { 101 }, {}, nil, 1, false, false)
        assert.is_true(allowed)   -- outside scope, not vetoed

        world.setUnitRegion(101, 'basin_a')
        allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.ATTACK, { 101 }, {}, nil, 1, false, false)
        assert.is_false(allowed)   -- inside scope, vetoed
    end)
end)

describe("breach detection off damage events (§2, E2)", function()
    it("breaches a ceasefire on partner-inflicted damage", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        world.frame = 10

        gadgetObj:UnitDamaged(101, nil, 20, 50, false, nil, nil, 201, nil, 10)
        assert.are.equal('breached', world.rp('parley_' .. id .. '_state'))
        assert.are.equal(-3, world.rp('trust_10_20'))
    end)

    it("E2: exempts damage from a shot fired before the truce's accept frame", function()
        local world, gadgetObj = newWorld()
        world.frame = 0
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })

        -- A projectile fired at frame 0 (before accept)...
        gadgetObj:ProjectileCreated(555, 201, nil)
        world.frame = 5
        GG.Parley.Respond(id, 20, 2, 'accept')   -- accept lands at frame 5

        -- ...resolves (lands) at frame 20, after the truce is active.
        world.frame = 20
        gadgetObj:UnitDamaged(101, nil, 20, 50, false, nil, 555, 201, nil, 10)
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))   -- exempt, not breached
    end)

    it("counts an instant-hit weapon (no projectileID) at the current frame, not exempt", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        world.frame = 50

        gadgetObj:UnitDamaged(101, nil, 20, 50, false, nil, nil, 201, nil, 10)
        assert.are.equal('breached', world.rp('parley_' .. id .. '_state'))
    end)
end)

describe("withdrawal notice (E5) vs breach", function()
    it("withdrawing ends the pact 'fulfilled' after the notice window, not 'breached'", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 100000 })
        GG.Parley.Respond(id, 20, 2, 'accept')

        world.frame = 10
        local ok = GG.Parley.Withdraw(id, 10)
        assert.is_true(ok)
        assert.are.equal('active', world.rp('parley_' .. id .. '_state'))   -- still enforced during notice

        world.frame = 10 + 900
        gadgetObj:GameFrame(world.frame)
        assert.are.equal('fulfilled', world.rp('parley_' .. id .. '_state'))
        assert.are.equal(1, world.rp('trust_10_20'))
    end)

    it("enforcement (order veto) still holds during the withdrawal notice window", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 100000 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        GG.Parley.Withdraw(id, 10)

        world.setUnit(101, 20, 5, 5, 100)
        local allowed = gadgetObj:AllowCommand(1, nil, 10, CMD.ATTACK, { 101 }, {}, nil, 1, false, false)
        assert.is_false(allowed)
    end)
end)

describe("joint_objective (§1)", function()
    it("widens eligibility to the counterparty team on accept", function()
        local world = newWorld()
        world.objectives[7] = { id = 7, state = 'active', forTeam = 10 }
        local id = GG.Parley.Propose(10, 1, 20, 'joint_objective', { objectiveId = 7 })
        GG.Parley.Respond(id, 20, 2, 'accept')

        assert.are.equal(1, #world.widenCalls)
        assert.are.equal(7, world.widenCalls[1].id)
        assert.are.equal(20, world.widenCalls[1].teamID)
    end)
end)

describe("intel (§1)", function()
    it("publishes the proposer's region-presence aggregate on accept", function()
        local world = newWorld()
        world.setUnit(301, 10, 1, 1, 40)
        world.setUnitRegion(301, 'basin_a')
        local id = GG.Parley.Propose(10, 1, 20, 'intel', { regionKeys = { 'basin_a' } })
        GG.Parley.Respond(id, 20, 2, 'accept')

        assert.are.equal('fulfilled', world.rp('parley_' .. id .. '_state'))
        assert.are.equal('basin_a', world.rp('parley_' .. id .. '_intelRegions'))
        assert.are.equal('40', world.rp('parley_' .. id .. '_intelStrengths'))
    end)
end)

describe("trust ledger (§2, §3)", function()
    it("+1 on fulfilled, -3 on breached, applied to the shared (unordered) pair", function()
        local world, gadgetObj = newWorld()
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        GG.Parley.Respond(id, 20, 2, 'accept')
        world.frame = 5
        gadgetObj:UnitDamaged(101, nil, 20, 50, false, nil, nil, 201, nil, 10)
        assert.are.equal(-3, world.rp('trust_10_20'))
        assert.are.equal(GG.Parley.Trust(10, 20), GG.Parley.Trust(20, 10))
    end)
end)

describe("resolved-proposal archive (PLAN-long-uptime S4)", function()
    -- `proposals[id]` used to be kept forever: the retention loop cleared the
    -- rulesParams of a resolved proposal and left the proposal table itself
    -- referenced for the life of the game. It now moves to a ring-capped
    -- archive. The cap is not directly observable — eviction is, and eviction
    -- is the only thing that proves the container is bounded at all.

    -- One propose→expire→age-out cycle. Expiry rather than rejection because
    -- rejecting puts the (from,to) pair on a 2-minute cooldown.
    local function resolveAndAge(world, gadgetObj)
        local id = GG.Parley.Propose(10, 1, 20, 'ceasefire', { duration = 1800 })
        assert.is_number(id)
        world.frame = world.frame + 1801        -- past the response deadline
        gadgetObj:GameFrame(world.frame)
        assert.are.equal('expired', world.rp('parley_' .. id .. '_state'))
        world.frame = world.frame + 901         -- past RESOLVE_RETENTION_FRAMES
        gadgetObj:GameFrame(world.frame)
        return id
    end

    it("keeps a just-resolved proposal readable after its params are cleared", function()
        local world, gadgetObj = newWorld()
        world.setPlayerPool(1, 100000)
        local id = resolveAndAge(world, gadgetObj)

        -- Params are gone from the wire...
        assert.is_nil(world.rp('parley_' .. id .. '_state'))
        -- ...but the record is still readable from the archive.
        local p = GG.Parley.Get(id)
        assert.is_table(p)
        assert.are.equal('expired', p.state)
    end)

    it("evicts the oldest resolved proposal once the archive cap is passed", function()
        local world, gadgetObj = newWorld()
        world.setPlayerPool(1, 1000000)

        local firstId = resolveAndAge(world, gadgetObj)
        assert.is_table(GG.Parley.Get(firstId))

        -- ARCHIVE_CAP is 256; push the first one out of the ring.
        for _ = 1, 256 do resolveAndAge(world, gadgetObj) end

        assert.is_nil(GG.Parley.Get(firstId))
    end)
end)
