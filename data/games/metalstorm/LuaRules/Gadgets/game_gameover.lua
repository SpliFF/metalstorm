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
    -- GG mirror for other gadgets. The rulesParam is the *client's* view;
    -- a gadget reading it back would go through a string round-trip to learn
    -- something this gadget already knows, so publish both. game_objectives
    -- reads this to stop generating new missions into a war that is ending.
    GG.WarState = warState
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
---
--- The sides table is the *scenario's* roster, and a room is not obliged to
--- staff all of it (D14 — rooms are sized by their slots, not by their war).
--- So every side team is checked against the teams this room actually has
--- before its allyteam is claimed as a winner. Without that check a scenario
--- team with no room slot contributes an allyteam id that does not exist —
--- Meridian Basin's 4-team `compact` side in a 2-slot room produced
--- {0,1,2,3} where 3 was nothing at all, and `Spring.GameOver` then dropped
--- it silently (LuaSyncedCtrl.cpp validates each id with ValidAllyTeam), so
--- the Lua log claimed four winners and the server relay reported three.
--- Gaia is excluded for the same reason it is excluded everywhere else: it
--- is the world, not a side, and it occupies a real team index that a
--- downsized room's scenario mapping will otherwise land on (in that same
--- 2-slot room, Gaia sat at team 2 and was declared a co-winner).
local function winnersFor(completingTeam)
    local allyOf = function(t)
        local a = Spring.GetTeamAllyTeamID(t)
        return a or t
    end

    -- "Staffed" means a team someone is actually playing — NOT merely a team
    -- the engine materialised. Seating the two sides on teams 0 and 4 (wars
    -- §7.4) makes the engine allocate teams 1-3 as unoccupied filler: they are
    -- live, they are in GetTeamList(), they are valid allyteams, and they have
    -- no leader and no units. Excluding only Gaia here let all three through,
    -- so a compact-side win told the player "Ally team 0, Ally team 1, Ally
    -- team 2 & Ally team 3 share victory" — three of the four do not exist.
    -- The asymmetry is why it survived D18: the union side's filler teams are
    -- Gaia or unallocated, so a team-4 win looked clean. The leader == -1 test
    -- is the same one game_scenario.lua's war_teams_unstaged check uses.
    local gaia = Spring.GetGaiaTeamID and Spring.GetGaiaTeamID() or nil
    local staffed = {}
    for _, t in ipairs(Spring.GetTeamList() or {}) do
        if t ~= gaia then
            local _, leader = Spring.GetTeamInfo(t)
            if leader and leader ~= -1 then staffed[t] = true end
        end
    end

    local faction = factionOf(completingTeam)
    if not faction then return { allyOf(completingTeam) } end

    local seen, out = {}, {}
    for _, s in ipairs(GG.Scenario.data.sides) do
        if s.faction == faction and s.team and staffed[s.team] then
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
    -- own terminal path: an objective whose criteria are MET at this instant
    -- settles normally (reward + escrow paid out), and every other one expires
    -- with its stakes refunded to the STAKERS' TEAM POOLS — wars §7's "not to
    -- individuals", which is the rule §7.2 recorded as unimplemented.
    local settledComplete, settledExpired = 0, 0
    if GG.Objectives and GG.Objectives.ExpireAllActive then
        settledComplete, settledExpired = GG.Objectives.ExpireAllActive()
        settledComplete = settledComplete or 0
        settledExpired  = settledExpired or 0
    end
    Spring.Echo('[game_gameover] resolving: settled ' ..
                (settledComplete + settledExpired) .. ' unresolved objective(s) — ' ..
                settledComplete .. ' met and paid, ' .. settledExpired ..
                ' expired with stakes refunded team-ward')
    Spring.SetGameRulesParam('war_settled_complete', settledComplete, PUBLIC)
    Spring.SetGameRulesParam('war_settled_expired', settledExpired, PUBLIC)

    -- §7 `resolving`: "Record the final scoreboard (teams §6) into the
    -- archive." The sim cannot write the archive — that is a lobby-side table
    -- and this process has no handle on it (WarStateSim.h: there is no DB
    -- callout from synced Lua). What it CAN do is freeze the scoreboard at the
    -- instant the war ended and stamp it, so the server's heartbeat scraper
    -- publishes THAT rather than whatever the params happen to hold when the
    -- lobby next looks. Without the stamp the archive would race the freeze:
    -- game_teams re-publishes its scoreboard on a 30 s cadence, so a war that
    -- ends 29 s into a cadence archives a scoreboard that is half a minute out
    -- of date, and one that ends after the sim freeze archives whatever the
    -- last tick left behind.
    Spring.SetGameRulesParam('war_final_frame', Spring.GetGameFrame(), PUBLIC)

    warState = 'over'
    publishState()

    Spring.Echo('[game_gameover] GAME OVER — winning allyteams {' ..
                joinIds(winners) .. '}')
    -- Spring.GameOver returns how many of the ids it *accepted* — it drops
    -- any that fail ValidAllyTeam. Log the two together: this line and the
    -- server relay's "N winning allyteam(s)" are the only record of what the
    -- clients were actually told, and when they disagreed nobody could tell
    -- whether an allyteam had been lost in transit or was never real
    -- (PLAN-endtoend D18 — it was the latter, and it cost a fire to
    -- establish that). winnersFor now only produces staffed teams, so a
    -- mismatch here means a genuinely new problem.
    local accepted = Spring.GameOver(winners)
    if accepted ~= #winners then
        Spring.Echo('[game_gameover] WARNING: declared ' .. #winners ..
                    ' winning allyteam(s) but the engine accepted ' ..
                    string.format('%d', accepted or 0) ..
                    ' — some ids are not valid allyteams in this room')
    end
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

-- The invariant, checked in the sim itself (PLAN-endtoend.md D10): a war with
-- no `victory = true` objective has no terminal condition and will run
-- forever. The lobby now defaults a scenario per map and warns at room start,
-- but this is the check that cannot be bypassed by *any* boot path —
-- create-room, --direct manifest, headless run — because it reads the staged
-- board rather than how the board was requested.
--
-- Frame 60, not GameStart: game_scenario stages objectives at GameStart and
-- resolves the deferred ones at frame 30, and game_objectives' systemic
-- generator has had a tick. By 2 s in, whatever this war has is what it has.
--
-- Loud, not fatal. A scenario-less war is legitimate (a sandbox, a smoke
-- fixture, the tutorial); what was wrong was that it looked identical to a
-- real one. Deliberately says so on the client too, so a player in an
-- endless room finds out at the start rather than by attrition.
local ENDLESS_CHECK_FRAME = 60
local endlessChecked = false

local function checkWarCanEnd()
    local count = GG.Objectives and GG.Objectives.VictoryObjectiveCount
        and GG.Objectives.VictoryObjectiveCount() or 0
    Spring.SetGameRulesParam('war_can_end', count > 0 and 1 or 0, PUBLIC)
    if count > 0 then return end

    local scenario = GG.Scenario and GG.Scenario.name
    Spring.Echo('[game_gameover] WARNING: this war has NO victory objective' ..
                (scenario
                    and (' — scenario "' .. scenario .. '" declares none')
                    or ' — no scenario was staged (the `scenario` modoption ' ..
                        'is unset)') ..
                '; it has no terminal condition and cannot end. ' ..
                'See PLAN-metalstorm-wars.md §7.1.')
end

-- ───────── The foothold census (PLAN-metalstorm-wars.md §7, task 4) ─────────
--
-- §7's second terminal condition is **faction elimination — a faction loses its
-- last foothold in the theatre**, explicitly NOT "a side has no players"
-- (teams §4.5: persistence keeps empty sides frozen, and an unmanned side is
-- not a defeated one). §7 assigns the condition itself to the War Director,
-- because it also has to weigh operator-retire and the season boundary, which
-- are live-ops facts no sim can see.
--
-- What the Director CANNOT see is the census: a side's start regions are
-- declared by the scenario (`world.regions` — each side opens owning exactly
-- its own landing zone) and their current ownership lives in game_regions'
-- rulesParams. Both are sim-local. So the split is: the sim COUNTS, the
-- Director DECIDES. This publishes the count.
--
-- Published per TEAM rather than per faction because a team is what the
-- scenario's regions block names and what `war_sides` maps faction-ward; the
-- lobby already owns that mapping and folding it in here would be a second
-- copy of it.
--
-- `war_footholds_known` gates the whole rule. A war with no scenario, or one
-- whose scenario declares no starting regions, publishes 0 and the Director
-- reads that as "cannot tell" — never as "everybody is eliminated". Ending a
-- war because a census was unavailable is the one failure mode worth spending
-- a flag to make unrepresentable.
local FOOTHOLD_PERIOD = 150   -- frames (5 s); a strategic quantity, not a tick

local function publishFootholds()
    local regions = GG.Scenario and GG.Scenario.data and GG.Scenario.data.world
        and GG.Scenario.data.world.regions
    if not regions or #regions == 0 then
        Spring.SetGameRulesParam('war_footholds_known', 0, PUBLIC)
        return
    end

    -- Count each side's DECLARED start regions that it still owns. A region it
    -- captured elsewhere is not a foothold in §7's sense — the condition is
    -- "all its start regions … gone", so a faction pushed off its own ground
    -- while sitting on someone else's is eliminated, which is the reading that
    -- makes the condition reachable at all.
    local held = {}
    for _, r in ipairs(regions) do
        if r.team then
            held[r.team] = held[r.team] or 0
            local owner = Spring.GetGameRulesParam('region_' .. tostring(r.key) .. '_team')
            if owner and math.floor(owner) == r.team then
                held[r.team] = held[r.team] + 1
            end
        end
    end
    for team, n in pairs(held) do
        Spring.SetGameRulesParam('war_footholds_' .. string.format('%d', team), n, PUBLIC)
    end
    Spring.SetGameRulesParam('war_footholds_known', 1, PUBLIC)
end

-- ─────────────── Snapshot state (PLAN-persistence task 1d, §7.1d) ───────────────
--
-- The whole terminal-condition machine is four values, and every one of them is
-- authored here rather than derivable: `warState` is a latch (§7's chain is
-- one-way and the first declaration wins), `resolveAtFrame` is an absolute frame
-- stamp, and `winners`/`winningTeam` are the *decision* — winnersFor() reads the
-- staffed roster at the moment of the win, so recomputing it after a restore
-- could produce a different answer than the one the players were shown.
--
-- Why this matters more than its size suggests: a war restored mid-wind-down
-- with `warState` back at 'active' has silently un-won itself, and the objective
-- that won it has already resolved — so nothing would ever declare it again.
--
-- `endlessChecked` travels too, for the opposite reason: it is a one-shot warn,
-- and a restore that resets it re-announces "this war has no victory objective"
-- to a client that has been playing for an hour. (`war_can_end` and the other
-- rulesParams are C++-side and ride the `teams` section, so they are not here.)
function gadget:Save(state)
    state.warState = warState
    state.resolveAtFrame = resolveAtFrame
    state.winningTeam = winningTeam
    state.winners = winners
    state.endlessChecked = endlessChecked
end

function gadget:Load(state)
    -- Defaults spelled out, not inherited from the live values: a rollback to
    -- before the win must CLEAR the latch, so an absent field means 'active',
    -- never "keep what this process happens to hold".
    warState       = state.warState or 'active'
    resolveAtFrame = state.resolveAtFrame
    winningTeam    = state.winningTeam
    winners        = state.winners
    endlessChecked = state.endlessChecked or false
    -- Re-publish: the rulesParams a client reads are restored by the snapshot's
    -- own team/game sections, but GG.WarState is this gadget's live mirror and
    -- other gadgets (game_objectives) branch on it in the same tick.
    publishState()
end

function gadget:GameFrame(frame)
    if not endlessChecked and frame >= ENDLESS_CHECK_FRAME then
        endlessChecked = true
        checkWarCanEnd()
    end
    if resolveAtFrame and frame >= resolveAtFrame then
        resolveAtFrame = nil
        resolve()
    end
    -- Keeps running through wind-down: the census is what the Director archives
    -- as the war's final territorial state, and freezing it at the moment the
    -- victory objective completed would miss the grace period's last push.
    if frame % FOOTHOLD_PERIOD == 0 then
        publishFootholds()
    end
end
