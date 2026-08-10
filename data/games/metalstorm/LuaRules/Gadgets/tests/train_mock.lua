-- tests/train_mock.lua — minimal Spring/GG/gadgetHandler mock so
-- game_train_spec.lua can load and drive the real game_train.lua gadget file
-- end-to-end. Same deliberate exception as game_teams_spec.lua's spring_mock.lua
-- (see that file's header): game_train.lua's consist bookkeeping and
-- breadcrumb kinematics ARE the thing under test, with no pure-module split
-- to exercise instead. Narrowly scoped to this gadget's Spring surface, not
-- a shared framework — extend narrowly if another train-adjacent file needs it.
--
-- UnitDefs here are real fable_train footprint values (zsize = footprintz*2,
-- per Spring's footprint convention), not arbitrary in-range placeholders —
-- that's what makes the geometry specs an honest regression guard against
-- the 2026-07-25 coupler-distance bug (mocked-in-range positions hid it).

local M = {}

-- The server's vendored Lua 5.4 builds with LUA_COMPAT_MATHLIB
-- (rts/lib/lua/include/luaconf.h), so math.atan2 exists in the live gadget
-- environment. Busted runs whatever Lua is installed locally (5.3+ removed
-- atan2), so mirror the server's compat surface here.
math.atan2 = math.atan2 or function(y, x) return math.atan(y, x) end

local SQUARE_SIZE = 8

-- Real fable_train.lua footprintz values (units/fable_train.lua): engine 9,
-- cars 7. zsize = footprintz * 2 (Spring convention: xsize/zsize are already
-- doubled for 2x2 blocking-square allocation).
M.ENGINE_DEF_ID = 1001
M.GUN_DEF_ID = 1002
M.TROOP_DEF_ID = 1003
M.CARGO_DEF_ID = 1004

local FOOTPRINTZ = { [M.ENGINE_DEF_ID] = 9, [M.GUN_DEF_ID] = 7, [M.TROOP_DEF_ID] = 7, [M.CARGO_DEF_ID] = 7 }
local ROLE = { [M.ENGINE_DEF_ID] = 'engine', [M.GUN_DEF_ID] = 'gun', [M.TROOP_DEF_ID] = 'troop', [M.CARGO_DEF_ID] = 'cargo' }

--- The real footprint half-length in elmos for a train def, computed the
--- same way the fix under test computes it — specs use this to derive
--- expected/spawn distances from first principles rather than copying the
--- gadget's own numbers back at it.
function M.HalfLength(defID)
    return FOOTPRINTZ[defID] * 2 * SQUARE_SIZE / 2
end

--- Build a fresh mock world + load a fresh game_train.lua instance against
--- it. Every spec gets its own instance (globals are process-wide in plain
--- Lua, so tests must not share state across `it` blocks).
function M.new()
    local world = {
        frame = 0,
        units = {},            -- unitID -> { x,y,z, heading, defID, dead, hp, maxHp, vx,vy,vz }
        rulesParams = {},      -- unitID -> key -> value
        moveCtrl = {},         -- unitID -> { enabled, noBlocking, positions = {{x,y,z}...}, headings = {...}, velocities = {...} }
        cmdDescs = {},         -- unitID -> {cmdDesc...}
        cobValues = {},        -- unitID -> cobID -> value
        groundMoveData = {},   -- unitID -> key -> value (MoveCtrl.SetGroundMoveTypeData)
        orders = {},           -- recorded Spring.GiveOrderToUnit calls
        echoes = {},           -- recorded Spring.Echo messages
    }

    function world.setUnit(unitID, opts)
        world.units[unitID] = {
            x = opts.x or 0, y = opts.y or 0, z = opts.z or 0,
            heading = opts.heading or 0,
            defID = opts.defID,
            dead = opts.dead == true,
            hp = opts.hp or 100, maxHp = opts.maxHp or 100,
            vx = opts.vx or 0, vy = opts.vy or 0, vz = opts.vz or 0,
        }
        world.moveCtrl[unitID] = world.moveCtrl[unitID] or { positions = {}, headings = {}, velocities = {} }
    end

    --- Move a unit's real position (as if its own move-type advanced it) and
    --- optionally its heading, without touching MoveCtrl state. Used to drive
    --- the leader forward between GameFrame() ticks in kinematics specs.
    function world.moveUnit(unitID, x, y, z, heading)
        local u = world.units[unitID]
        u.x, u.y, u.z = x, y, z
        if heading ~= nil then u.heading = heading end
    end

    function world.kill(unitID)
        world.units[unitID].dead = true
    end

    function world.rp(unitID, key)
        local t = world.rulesParams[unitID]
        return t and t[key]
    end

    -- ---- Spring mock ----
    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        GetAllUnits = function()
            local out = {}
            for unitID in pairs(world.units) do out[#out + 1] = unitID end
            table.sort(out)
            return out
        end,
        GetUnitDefID = function(unitID)
            local u = world.units[unitID]
            return u and u.defID
        end,
        GetUnitPosition = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            return u.x, u.y, u.z
        end,
        GetUnitHeading = function(unitID)
            local u = world.units[unitID]
            return u and u.heading
        end,
        -- Real front vector. In this mock heading 0 faces +Z; note the real
        -- engine's heading↔vector mapping differs (RH flip), which is exactly
        -- why the gadget uses GetUnitDirection instead of heading math.
        GetUnitDirection = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            local h = (u.heading or 0) * math.pi / 32768
            return math.sin(h), 0, math.cos(h)
        end,
        GetUnitVelocity = function(unitID)
            local u = world.units[unitID]
            if not u then return nil end
            local speed = math.sqrt(u.vx * u.vx + u.vz * u.vz)
            return u.vx, u.vy, u.vz, speed
        end,
        GetUnitIsDead = function(unitID)
            local u = world.units[unitID]
            return u and u.dead or false
        end,
        GetUnitHealth = function(unitID)
            local u = world.units[unitID]
            if not u or u.dead then return nil end
            return u.hp, u.maxHp
        end,
        GetUnitIsTransporting = function() return nil end,
        GetUnitTransporter = function() return nil end,
        ValidUnitID = function(unitID) return world.units[unitID] ~= nil end,
        SetUnitRulesParam = function(unitID, key, value)
            world.rulesParams[unitID] = world.rulesParams[unitID] or {}
            world.rulesParams[unitID][key] = value
        end,
        GetUnitRulesParam = function(unitID, key)
            local t = world.rulesParams[unitID]
            return t and t[key]
        end,
        InsertUnitCmdDesc = function(unitID, cmdDesc)
            world.cmdDescs[unitID] = world.cmdDescs[unitID] or {}
            table.insert(world.cmdDescs[unitID], cmdDesc)
        end,
        SetUnitRotation = function(unitID, _, heading, _z)
            world.units[unitID].heading = heading
        end,
        SetUnitCOBValue = function(unitID, cobID, value)
            world.cobValues[unitID] = world.cobValues[unitID] or {}
            world.cobValues[unitID][cobID] = value
        end,
        GiveOrderToUnit = function(unitID, cmdID, params, options)
            world.orders[#world.orders + 1] = { unitID = unitID, cmdID = cmdID, params = params }
            -- The real engine's CommandAI.GiveCommand dispatches
            -- eventHandler.AllowCommand synchronously for every order,
            -- including ones issued from synced Lua (Spring.GiveOrderToUnit
            -- goes through the same path as a player-issued order) — mirror
            -- that here so specs can exercise the game_train.lua
            -- re-entrancy guard for real instead of just asserting the
            -- order got recorded.
            local u = world.units[unitID]
            if u and _G.gadget and _G.gadget.AllowCommand then
                _G.gadget:AllowCommand(unitID, u.defID, 1, cmdID, params, options or {}, 0, 1, false, false)
            end
            return true
        end,
        UnitDetach = function() end,
        SetUnitPosition = function() end,
        Echo = function(msg) world.echoes[#world.echoes + 1] = msg end,
        MoveCtrl = {
            Enable = function(unitID)
                world.moveCtrl[unitID] = world.moveCtrl[unitID] or { positions = {}, headings = {}, velocities = {} }
                world.moveCtrl[unitID].enabled = true
            end,
            Disable = function(unitID)
                if world.moveCtrl[unitID] then world.moveCtrl[unitID].enabled = false end
            end,
            SetNoBlocking = function(unitID, v)
                world.moveCtrl[unitID].noBlocking = v
            end,
            SetExtrapolate = function(unitID, v)
                world.moveCtrl[unitID].extrapolate = v
            end,
            SetPosition = function(unitID, x, y, z)
                local mc = world.moveCtrl[unitID]
                table.insert(mc.positions, { x = x, y = y, z = z })
                local u = world.units[unitID]
                u.x, u.y, u.z = x, y, z
            end,
            SetHeading = function(unitID, headingSpring)
                local mc = world.moveCtrl[unitID]
                table.insert(mc.headings, headingSpring)
                world.units[unitID].heading = headingSpring
            end,
            SetVelocity = function(unitID, vx, vy, vz)
                local mc = world.moveCtrl[unitID]
                table.insert(mc.velocities, { vx = vx, vy = vy, vz = vz })
            end,
            SetGroundMoveTypeData = function(unitID, key, value)
                world.groundMoveData[unitID] = world.groundMoveData[unitID] or {}
                world.groundMoveData[unitID][key] = value
            end,
        },
    }

    -- Mirror the REAL engine's CMD table (rts/Lua/LuaConstCMD.cpp values).
    -- Deliberately no ATTACK_MOVE entry: attack-move is CMD.FIGHT in
    -- Spring/Recoil, and a mocked-in ATTACK_MOVE constant previously hid the
    -- gadget comparing cmdID against a nil constant.
    _G.CMD = { STOP = 0, MOVE = 10, PATROL = 15, FIGHT = 16, UNLOAD_UNITS = 105, UNLOAD_UNIT = 106 }
    _G.CMDTYPE = { ICON_UNIT = 1, ICON = 2 }
    _G.Game = { gameSpeed = 30 }

    -- speed is elmos/sec (UnitDefs convention: maxvelocity * gameSpeed);
    -- fable_train engine maxvelocity=2.4 → 72 (cars are 1.8 but only the
    -- leader's — an engine's — speed cap matters to the gadget).
    _G.UnitDefs = {}
    for defID, footprintz in pairs(FOOTPRINTZ) do
        _G.UnitDefs[defID] = {
            zsize = footprintz * 2,
            speed = 72,
            customParams = { couple_links = 'link_f,link_r', train_role = ROLE[defID] },
        }
    end

    -- game_train.lua now pulls the shared skip-safe tick gate (D15) through the
    -- real gadget loader's VFS, so the mock has to answer that call. Same
    -- mapping the other gadget mocks use: busted's cwd is LuaRules/Gadgets/.
    _G.VFS = {
        Include = function(path)
            return dofile('./' .. path:gsub('^LuaRules/Gadgets/', ''))
        end,
    }

    _G.gadgetHandler = {
        IsSyncedCode = function() return true end,
        RegisterCMDID = function() end,
    }
    _G.gadget = {}
    _G.GG = {}

    -- game_train.lua lives directly in Gadgets/ (no subfolder nesting), and
    -- busted runs with cwd = the invocation directory (Gadgets/, per the
    -- game_teams_spec.lua convention), so the path is './game_train.lua'.
    dofile('./game_train.lua')
    -- game_train.lua returns nothing when synced; it attaches methods to the
    -- global `gadget` table and GG.Train instead (the real gadget-loader
    -- contract plus this fix's programmatic seam).
    return world, _G.gadget
end

return M
