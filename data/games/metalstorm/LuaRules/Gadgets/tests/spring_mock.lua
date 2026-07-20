-- tests/spring_mock.lua — minimal Spring/GG/gadgetHandler mock so
-- game_teams_spec.lua can load and drive the real game_teams.lua gadget
-- file end-to-end. Same deliberate exception as objectives/tests/spring_mock.lua
-- (see that file's header for why gadget-level mocking earns its cost here):
-- game_teams.lua IS the orchestration (task 1 explicitly keeps it thin, but
-- thin still means "the callin sequencing itself is the thing under test"),
-- so there's no pure-module split to test instead. Narrowly extended for
-- this file only — not a shared framework.

local M = {}

--- Build a fresh mock world + load a fresh game_teams.lua instance against
--- it. Every spec gets its own instance (globals are process-wide in plain
--- Lua, so tests must not share state across `it` blocks).
function M.new()
    local world = {
        frame = 0,
        players = {},              -- playerID -> { team, active, spectator }
        modOptions = {},
        teamRulesParams = {},      -- teamID -> key -> value
        gameRulesParams = {},      -- key -> value
        suggestCalls = {},         -- recorded GG.Objectives.SuggestFor(id, playerID) calls
        lowestParticipationByTeam = {},  -- teamID -> objective id (test-controlled)
        onAwardHandlers = {},
        onChargeHandlers = {},
        onCompleteHandlers = {},
        caretakerActivations = {}, -- recorded GG.AI.ActivateCaretaker(teamID) calls
    }

    function world.setPlayer(playerID, teamID, active, spectator)
        world.players[playerID] = {
            team = teamID, active = active ~= false, spectator = spectator == true,
        }
    end

    function world.trp(teamID, key)
        local t = world.teamRulesParams[teamID]
        return t and t[key]
    end

    function world.rp(key)
        return world.gameRulesParams[key]
    end

    --- Drive the registered GG.Authority.OnAward hooks, as game_authority.lua
    --- would after a real Award() call.
    function world.fireAward(playerID, teamID, amount)
        for _, fn in ipairs(world.onAwardHandlers) do fn(playerID, teamID, amount) end
    end

    --- Drive the registered GG.Authority.OnCharge hooks.
    function world.fireCharge(playerID, teamID, amount)
        for _, fn in ipairs(world.onChargeHandlers) do fn(playerID, teamID, amount) end
    end

    --- Drive the registered GG.Objectives.OnComplete hooks.
    function world.fireComplete(o, completingTeam)
        for _, fn in ipairs(world.onCompleteHandlers) do fn(o, completingTeam) end
    end

    -- ---- Spring mock ----
    _G.Spring = {
        GetGameFrame = function() return world.frame end,
        GetModOptions = function() return world.modOptions end,
        GetPlayerInfo = function(playerID, _)
            local p = world.players[playerID]
            if not p then return nil end
            return 'player' .. playerID, p.active, p.spectator, p.team
        end,
        -- Mirrors rts/Lua/LuaSyncedRead.cpp GetPlayerList: teamID<0 (or nil)
        -- = no team filter (specs included); a specific teamID excludes
        -- specs unconditionally, `active` additionally filters to active==true.
        GetPlayerList = function(a, b)
            local teamID, activeOnly
            if type(a) == 'number' then
                teamID, activeOnly = a, b
            elseif type(a) == 'boolean' then
                activeOnly, teamID = a, b
            end
            local out = {}
            for playerID, p in pairs(world.players) do
                local include = true
                if teamID ~= nil and teamID >= 0 then
                    if p.spectator or p.team ~= teamID then include = false end
                end
                if activeOnly and not p.active then include = false end
                if include then out[#out + 1] = playerID end
            end
            table.sort(out)
            return out
        end,
        SetTeamRulesParam = function(teamID, key, value, _los)
            world.teamRulesParams[teamID] = world.teamRulesParams[teamID] or {}
            world.teamRulesParams[teamID][key] = value
        end,
        GetTeamRulesParam = function(teamID, key)
            local t = world.teamRulesParams[teamID]
            return t and t[key]
        end,
        SetGameRulesParam = function(key, value) world.gameRulesParams[key] = value end,
        GetGameRulesParam = function(key) return world.gameRulesParams[key] end,
    }

    _G.gadgetHandler = { IsSyncedCode = function() return true end }
    _G.gadget = {}

    _G.GG = {
        Authority = {
            OnAward = function(fn) world.onAwardHandlers[#world.onAwardHandlers + 1] = fn end,
            OnCharge = function(fn) world.onChargeHandlers[#world.onChargeHandlers + 1] = fn end,
        },
        Objectives = {
            LowestParticipationTactical = function(teamID)
                return world.lowestParticipationByTeam[teamID]
            end,
            SuggestFor = function(id, playerID)
                world.suggestCalls[#world.suggestCalls + 1] = { id = id, playerID = playerID }
            end,
            OnComplete = function(fn) world.onCompleteHandlers[#world.onCompleteHandlers + 1] = fn end,
        },
        -- GG.AI is deliberately absent by default (no AI runtime exists yet,
        -- PLAN-metalstorm-ai.md's AI0 blocker) — tests that want to assert
        -- the activation hook fires set world.installCaretakerAI() first.
    }

    function world.installCaretakerAI()
        _G.GG.AI = {
            ActivateCaretaker = function(teamID)
                world.caretakerActivations[#world.caretakerActivations + 1] = teamID
            end,
        }
    end

    -- game_teams.lua lives directly in Gadgets/ (no subfolder nesting, unlike
    -- objectives/regions/authority), and busted runs with cwd = the invocation
    -- directory (Gadgets/, per this file's header instructions), not this
    -- script's own directory — so the path is './game_teams.lua', not '../'.
    local gadgetChunk = dofile('./game_teams.lua')
    -- game_teams.lua returns nothing when synced; it attaches methods to
    -- the global `gadget` table instead (the real gadget-loader contract).
    return world, _G.gadget
end

return M
