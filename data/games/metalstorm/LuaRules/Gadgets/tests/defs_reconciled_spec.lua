-- tests/defs_reconciled_spec.lua — the game's half of a balance patch landing on
-- a resumed war (PLAN-def-reconciliation.md task 4, §2 steps 5-6).
--
-- Covers the two gadgets whose handlers are about telling somebody rather than
-- repairing state: game_warlog.lua (the digest a returning player reads) and
-- game_authority.lua (the cost-spec version its clients mirror). The objectives
-- half — where state really is repaired — is in
-- objectives/tests/defs_reconciled_spec.lua, against that directory's own mock.
--
-- Run from the plugin root:
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/

package.path = './?.lua;' .. package.path

--- The shape BuildDefsReconciledDelta produces (rts/Server/SimSnapshot.cpp).
--- Written out in full here rather than built by a helper with defaults: the
--- delta is a wire contract between C++ and Lua, and a fixture that fills in
--- missing keys would hide the case where a handler reads one that is absent.
local function delta(over)
    local d = {
        counts = {
            buildOrdersDropped = 0, featureDefsAdded = 0, featureDefsRenumbered = 0,
            featureDefsRetuned = 0, featuresAdjusted = 0, featuresDropped = 0,
            featuresHealthScaled = 0, ordersDeactivated = 0, unitDefsAdded = 0,
            unitDefsRenumbered = 0, unitDefsRetuned = 0, unitFieldsAuthored = 0,
            unitFieldsReDerived = 0, unitsAdjusted = 0, unitsDropped = 0,
            unitsHealthScaled = 0, weaponDefsAdded = 0, weaponDefsRenumbered = 0,
        },
        digest = 'nothing to remap | no def scalar moved',
        droppedFeatures = {}, droppedUnits = {},
        features = { removed = {}, renamed = {}, retuned = {} },
        retunesKnown = true,
        units = { removed = {}, renamed = {}, retuned = {} },
        weapons = { removed = {} },
    }
    for k, v in pairs(over or {}) do
        if type(v) == 'table' and type(d[k]) == 'table' then
            for kk, vv in pairs(v) do d[k][kk] = vv end
        else
            d[k] = v
        end
    end
    return d
end

-- ════════════════════════════ the digest ════════════════════════════

--- A bare harness for game_warlog.lua. It needs almost nothing — the ring IS
--- gameRulesParams — so this stays inline rather than growing another mock file.
local function warlogWorld()
    local world = { frame = 4200, params = {}, logs = {} }
    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        SetGameRulesParam = function(key, value) world.params[key] = value end,
        GetGameRulesParam = function(key) return world.params[key] end,
        Log = function(section, level, msg)
            world.logs[#world.logs + 1] = { section = section, level = level, msg = msg }
        end,
    }
    _G.LOG = { ERROR = 'ERROR', WARNING = 'WARNING', NOTICE = 'NOTICE', INFO = 'INFO' }
    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}
    _G.GG = {}
    dofile('./game_warlog.lua')
    local g = _G.gadget
    g:Initialize()

    --- Every event in the ring, oldest first, as the server's drain reads it.
    function world.events()
        local out = {}
        local head = world.params['warlog_seq'] or 0
        local ring = world.params['warlog_ring']
        for seq = 1, head do
            local slot = seq % ring
            local p = 'warlog_' .. slot .. '_'
            if world.params[p .. 'seq'] == seq then
                out[#out + 1] = {
                    kind = world.params[p .. 'kind'],
                    subject = world.params[p .. 'subject'],
                    detail = world.params[p .. 'detail'],
                    team = world.params[p .. 'team'],
                }
            end
        end
        return out
    end

    return world, g
end

describe("the balance-patch digest (§2 step 6)", function()
    it("names the removed defs that actually cost this war units", function()
        local world, g = warlogWorld()
        g:DefsReconciled(delta({
            counts = { unitsDropped = 6, unitsAdjusted = 11, ordersDeactivated = 2 },
            units = { removed = { 'bastion', 'raven' } },
            droppedUnits = { 4, 5, 6, 7, 8, 9 },
        }))

        local ev = world.events()
        assert.are.equal(3, #ev)                     -- two removals + the summary
        assert.are.equal('patch', ev[1].kind)
        assert.are.equal('bastion', ev[1].subject)
        assert.are.equal('removed', ev[1].detail)
        assert.are.equal(-1, ev[1].team)             -- nobody did this
        assert.are.equal('raven', ev[2].subject)
        assert.are.equal('summary', ev[3].detail)
        assert.are.equal('11 units retuned, 6 units lost, 2 orders stood down',
                         ev[3].subject)
    end)

    it("does not name a def this war never fielded", function()
        -- A patch can delete a def that never appeared in this world. That is
        -- news to the game's authors and not to anybody who played the war, and
        -- `unitsDropped` is the count that tells them apart.
        local world, g = warlogWorld()
        g:DefsReconciled(delta({
            counts = { unitsAdjusted = 3 },
            units = { removed = { 'siege_mortar' } },
        }))

        local ev = world.events()
        assert.are.equal(1, #ev)
        assert.are.equal('summary', ev[1].detail)
        assert.are.equal('3 units retuned', ev[1].subject)
    end)

    it("caps the per-def lines so a big patch cannot lap the ring", function()
        -- The ring holds 32 events and IS the war's strategic history. A patch
        -- that removed 50 defs would emit 50 lines and destroy everything the
        -- digest exists to carry — the patch note would eat the war.
        local world, g = warlogWorld()
        local removed, dropped = {}, {}
        for i = 1, 50 do
            removed[i] = 'unit_' .. i
            dropped[i] = 100 + i
        end
        g:DefsReconciled(delta({
            counts = { unitsDropped = 50 },
            units = { removed = removed },
            droppedUnits = dropped,
        }))

        local ev = world.events()
        assert.are.equal(5, #ev)                    -- PATCH_DEF_LINES + summary
        assert.are.equal('summary', ev[#ev].detail)
        -- The summary still carries the TRUE total, which is what makes the cap
        -- a presentation choice rather than a lost fact.
        assert.are.equal('50 units lost', ev[#ev].subject)
        -- And it is said out loud rather than silently truncated.
        assert.are.equal(1, #world.logs)
        assert.is_truthy(world.logs[1].msg:find('4 of 50'))
    end)

    it("still reports a patch that touched nothing visible", function()
        -- The engine only fires the call-in when the defs really moved, so
        -- "nothing you can see changed" is still the answer to why the war
        -- restarted with different numbers.
        local world, g = warlogWorld()
        g:DefsReconciled(delta())
        local ev = world.events()
        assert.are.equal(1, #ev)
        assert.are.equal('no visible change', ev[1].subject)
    end)

    it("keeps the seq monotonic, so the server's drain does not lose the patch", function()
        -- The seq is the drain's watermark across a hibernate/resume. A patch
        -- emitting from a restored cursor must continue the war's numbering.
        local world, g = warlogWorld()
        g:Load({ eventSeq = 17 })
        g:DefsReconciled(delta({
            counts = { unitsDropped = 1 },
            units = { removed = { 'bastion' } },
            droppedUnits = { 3 },
        }))
        assert.are.equal(19, world.params['warlog_seq'])   -- 17 + removal + summary
    end)
end)

-- ══════════════════════ the client cost mirror ══════════════════════

describe("the authority cost-spec version", function()
    local mock = require('tests.authority_charge_mock')
    local CostSpec = dofile('../Configs/authority_cost.lua')

    it("is published at boot, so a client can tell its mirror is stale", function()
        -- ui/lib/authority-cost.js disables prediction on a version mismatch,
        -- and until this param existed there was nothing to mismatch against: a
        -- client with a cached JSON predicted confidently wrong costs.
        local world, g = mock.new()
        g:Initialize()
        assert.are.equal(CostSpec.version, world.gameRulesParams['authority_cost_version'])
    end)

    it("is re-published when the defs move under a resumed war", function()
        local world, g = mock.new()
        g:Initialize()
        world.gameRulesParams['authority_cost_version'] = nil   -- as a stale payload would leave it
        g:DefsReconciled(delta({ counts = { unitsAdjusted = 2 } }))
        assert.are.equal(CostSpec.version, world.gameRulesParams['authority_cost_version'])
    end)
end)
