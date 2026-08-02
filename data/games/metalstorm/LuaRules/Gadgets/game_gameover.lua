-- game_gameover.lua — the war's terminal condition, and the only thing in
-- Metalstorm that declares the game over.
--
-- WHY THIS FILE EXISTS (PLAN-endtoend.md D1): nothing in Metalstorm content
-- ever called Spring.GameOver, and the engine's hardcoded last-team-standing
-- fallback is deliberately gated off for this game
-- (ShouldRunEliminationFallback, rts/Server/GameOverState.h — it assumes teams
-- 0/1, while Metalstorm rooms put humans at arbitrary indices and carry filler
-- AI slots with no start unit that would read as "eliminated"). Both game-over
-- paths in StateStreamer::Tick were therefore dead: a Metalstorm match could
-- not end. That exclusion is correct and stays; this gadget is the faithful
-- replacement it was waiting for.
--
-- THE DESIGN CALL (PLAN-metalstorm-wars.md §7.1, decided 2026-08-02): there is
-- exactly ONE termination concept — the war's. A single browser match does not
-- get its own cheaper finish, because Spring.GameOver is sim-wide: declaring
-- it ends the world for every connected client at once, so "this player's
-- match is over while the war continues" cannot be expressed without lying to
-- everyone else. What makes a finish reachable inside one session instead is
-- that **the scenario sizes its own war**: a scenario file IS a war template
-- (wars §3), so it declares which of its objectives is terminal via
-- `victory = true`. Meridian Basin's strategic hold on the basin is the first
-- one. A war whose scenario declares no victory objective simply never ends
-- in-session, and the player leaves by detaching (endtoend E11) — that is a
-- real answer, not a gap.
--
-- WHAT THIS OWNS: the sim half of the §7 chain —
--     active → winding_down → resolving → Spring.GameOver(winners)
-- The lobby-side War Director owns the rest (`archived`, the war-over digest,
-- the `wars` row); wars tasks 1/4, not started.
--
-- NOT IMPLEMENTED HERE, on purpose: §7's other two terminal conditions.
-- Faction elimination needs the theatre's start-region + command-nexus set,
-- and operator-retire/season-end needs live-ops input; both are the Director's
-- and neither is sim-local. Only the victory-objective condition is here.

function gadget:GetInfo()
    return {
        name    = "GameOver",
        desc    = "War terminal conditions — winding_down/resolving, then Spring.GameOver",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        -- After objectives (-50): OnComplete must be registered against a
        -- GG.Objectives table that already exists. gadgetHandler loads higher
        -- layer numbers later.
        layer   = 0,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- §7 "players notified; a grace period for a final push". 10 s at 30 Hz —
-- long enough to read as a beat and to let the client show the wind-down,
-- short enough that it is not a stall on a finished war.
local WINDING_DOWN_FRAMES = 300

local PUBLIC = { public = true }

-- 'active' | 'winding_down' | 'resolving' | 'over'. Only the sim-visible
-- subset of wars §7 — 'seeding'/'open'/'archived' are Director states and
-- never appear here.
local warState = 'active'
local resolveAtFrame = nil
local winners = nil          -- allyteam list handed to Spring.GameOver
local winningTeam = nil

--- "0,1,2,3", not "0.0,1.0,2.0,3.0". Spring hands allyteam ids back as Lua
--- numbers (floats), so a bare table.concat publishes a param a UI has to
--- parse around; %d makes the published string and the log line say what the
--- ids actually are.
local function joinIds(ids)
    local parts = {}
    for i, v in ipairs(ids or {}) do parts[i] = string.format('%d', v) end
    return table.concat(parts, ',')
end

local function publishState()
    Spring.SetGameRulesParam('war_state', warState, PUBLIC)
    if winningTeam then
        Spring.SetGameRulesParam('war_winner_team', winningTeam, PUBLIC)
        Spring.SetGameRulesParam('war_winner_ally_teams', joinIds(winners), PUBLIC)
    end
end

--- The scenario's faction for `teamID`, or nil when there's no scenario (a
--- --direct boot with no scenario file) or the team isn't listed in it.
local function factionOf(teamID)
    local sides = GG.Scenario and GG.Scenario.data and GG.Scenario.data.sides
    if not sides then return nil end
    for _, s in ipairs(sides) do
        if s.team == teamID then return s.faction end
    end
    return nil
end

--- The winning side's allyteams.
---
--- A "side" is one faction's whole force (wars §1), which in Metalstorm rooms
--- is several Spring teams — Meridian Basin runs teams 0-3 as `compact` and
--- 4-7 as `union`. The engine gives every team its own allyteam
--- (`teamAllyteam == team`, rts/Server/Simulation.cpp:507), so a 4-team
--- faction is 4 allyteams and handing Spring.GameOver only the completing
--- team's would tell three of that faction's own players they lost. Collect
--- every teammate-by-faction instead.
---
--- Falls back to just the completing team's allyteam when there is no sides
--- table to group by — the honest answer when the game can't know who else
--- was on that side.
local function winnersFor(completingTeam)
    local allyOf = function(t)
        local a = Spring.GetTeamAllyTeamID(t)
        return a or t
    end

    local faction = factionOf(completingTeam)
    if not faction then return { allyOf(completingTeam) } end

    local seen, out = {}, {}
    for _, s in ipairs(GG.Scenario.data.sides) do
        if s.faction == faction and s.team then
            local a = allyOf(s.team)
            if not seen[a] then
                seen[a] = true
                out[#out + 1] = a
            end
        end
    end
    if #out == 0 then return { allyOf(completingTeam) } end
    table.sort(out)
    return out
end

--- A victory objective resolved 'complete' — start the war winding down.
--- Idempotent: the first terminal condition wins, exactly as GameOverRelay
--- latches the first declaration server-side. A second victory objective
--- completing during the grace window does not change the result.
local function beginWindDown(o, completingTeam)
    if warState ~= 'active' then return end
    completingTeam = completingTeam or o.forTeam
    if not completingTeam then
        -- An open-race objective always resolves WITH a team (control.check
        -- returns the region's owner), so this is a content bug in a scoped
        -- objective, not a normal path. Loud, and no game over — declaring a
        -- winner we can't name is worse than not ending.
        Spring.Echo('[game_gameover] WARNING: victory objective ' .. tostring(o.id) ..
                    ' completed with no completing team — war continues')
        return
    end

    winningTeam = completingTeam
    winners = winnersFor(completingTeam)
    warState = 'winding_down'
    resolveAtFrame = Spring.GetGameFrame() + WINDING_DOWN_FRAMES
    publishState()

    Spring.Echo('[game_gameover] VICTORY: objective ' .. tostring(o.id) .. ' (' ..
                tostring(o.type) .. ') completed by team ' .. tostring(completingTeam) ..
                ' — winding down, allyteams {' .. joinIds(winners) ..
                '} win at frame ' .. string.format('%d', resolveAtFrame))
end

--- Grace expired: settle, then declare.
local function resolve()
    warState = 'resolving'
    publishState()

    -- §7 resolving: "every unresolved objective with staked authority disposes
    -- deterministically... no authority is destroyed or awarded to the enemy
    -- by war end". ExpireAllActive routes each through the objectives gadget's
    -- own terminal path, which calls GG.Authority.SettleEscrow(id, 'expired')
    -- and refunds the stakes.
    local swept = GG.Objectives and GG.Objectives.ExpireAllActive
        and GG.Objectives.ExpireAllActive() or 0
    Spring.Echo('[game_gameover] resolving: settled ' .. swept .. ' unresolved objective(s)')

    warState = 'over'
    publishState()

    Spring.Echo('[game_gameover] GAME OVER — winning allyteams {' ..
                joinIds(winners) .. '}')
    Spring.GameOver(winners)
end

function gadget:Initialize()
    if not (GG.Objectives and GG.Objectives.OnComplete) then
        -- game_objectives.lua is allow-listed and loads at layer -50, before
        -- this gadget. If it ever isn't, the war silently becomes unendable
        -- again — which is precisely the failure this file exists to fix, so
        -- say so rather than no-op.
        Spring.Echo('[game_gameover] ERROR: GG.Objectives.OnComplete missing — ' ..
                    'no victory objective can be watched; this war cannot end')
        return
    end

    GG.Objectives.OnComplete(function(o, completingTeam)
        if o.victory then beginWindDown(o, completingTeam) end
    end)

    publishState()
end

function gadget:GameFrame(frame)
    if resolveAtFrame and frame >= resolveAtFrame then
        resolveAtFrame = nil
        resolve()
    end
end
