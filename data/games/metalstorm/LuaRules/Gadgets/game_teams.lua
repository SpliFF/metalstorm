-- game_teams.lua — player lifecycle over team ownership (PLAN-metalstorm-teams.md).
--
-- Thin orchestration gadget for the drop-in/drop-out *deltas* over
-- Spring-native team sharing (§1): joiner onboarding (suggested starter
-- objective via GG.Objectives — the JOIN_GRANT mint itself is
-- game_authority.lua's own PlayerAdded, task-teams-2 note), leaver handling
-- (leader reassignment + caretaker-AI activation — the authority pool merge
-- and objective participation redirect are already automatic elsewhere,
-- §4 notes), and the per-player contribution scoreboard (§6).
--
-- ============================================================
-- THE "NO OWNERSHIP CODE" RULE (§1, binding on this whole file)
-- ============================================================
-- Units and orders belong to the TEAM, never to a player. Spring already
-- gives every player on a team command of every team unit (CTeam::AddPlayer)
-- and orders live on the unit's own command queue, referencing nothing about
-- who issued them once charged. So when a player leaves: NOTHING happens to
-- their units or orders — no reassignment, no transfer, no "who inherits
-- this squad" logic. That is not an oversight; it is the entire point of
-- "the team owns everything" (PLAN-metalstorm-teams.md §1, PLAN-metalstorm.md
-- §2). If you find yourself writing a function that moves a unit, a command
-- queue, or a build job from one player to another, STOP — you are writing
-- ownership-transfer code that this plan explicitly forbids. The only things
-- that move on a leave are: the player's authority pool (game_authority.lua,
-- merges into the team pool) and their accumulated objective participation
-- share (game_objectives.lua, redirects team-ward at resolve, not at leave).
-- Both already exist elsewhere; this file only sequences the parts that are
-- actually its own (leader bookkeeping, caretaker activation, scoreboard).
--
-- ============================================================
-- LEADER IS BOOKKEEPING, NOT A PRIVILEGE (§5)
-- ============================================================
-- Spring's CTeam::leader has exactly one live effect anywhere in this
-- engine: it is the default playerNum for a Lua-issued command that omits
-- one (CommandAI.cpp:~817) — and Metalstorm doesn't even use that path
-- (game_authority_charge.lua stamps `last_commander` from the actual
-- charging playerID on every paid order, never from team leader). There is
-- also no Lua setter for CTeam::leader in this engine (verified: no
-- SetTeamLeader-shaped call in rts/Lua/LuaSyncedCtrl.cpp) — so this file
-- cannot and does not touch the real engine leader at all. What it tracks
-- instead is a SEPARATE, purely-Lua `team_leader` rulesParam: a "who's
-- nominally in charge" bookkeeping value for the scoreboard/UI, decided by
-- OUR OWN policy (longest-tenured present player, §5). It confers no
-- gameplay privilege whatsoever — don't build a "team captain" feature on
-- it without first re-reading this note.
--
-- LOAD ORDER CONTRACT (see PLAN-metalstorm-structure.md "Gadget layer map"):
-- layer -95 — after game_authority (-100) so GG.Authority exists even at
-- this gadget's own file-load time; before everything else. GG.Objectives
-- (layer -50) loads AFTER this file, but that only matters for top-level
-- code — every gadget's Initialize() callin fires only once ALL gadget
-- files have loaded (regardless of layer), so GG.Objectives is safely
-- available inside gadget:Initialize() below.
--
-- Cross-plan contracts:
--   * PLAN-metalstorm-authority.md  — JOIN_GRANT mint + authority_granted_<id>
--                                     guard (game_authority.lua's own
--                                     PlayerAdded/PlayerRemoved); OnAward/
--                                     OnCharge hooks (task 4, this file)
--   * PLAN-metalstorm-objectives.md — suggested_for hint param; participation
--                                     redirect (distributeAward's
--                                     isPlayerActive filter, already automatic);
--                                     OnComplete hook (task 4, this file)
--   * PLAN-metalstorm-ai.md         — ai_caretaker modoption activates the
--                                     caretaker profile when a side empties
--                                     (this file only fires the hook; the
--                                     profile's behaviour is that plan's)
--   * PLAN-metalstorm-wars.md       — §A8: an EMPTY side hibernates, it does
--                                     NOT accrue income (this file has no
--                                     part in that — it's an income-tick
--                                     concern, not a player-lifecycle one)

function gadget:GetInfo()
    return {
        name    = "Team Lifecycle",
        desc    = "Drop-in/out deltas: joiner hint, leaver handling, leader, scoreboard",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -95,             -- after authority (-100)
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local ALLIED_LOS = { allied = true }   -- matches game_authority.lua's team-param visibility (§1)
local SCOREBOARD_PERIOD_FRAMES = 900   -- 30s @ GAME_SPEED 30 (§6 "slow cadence")
-- §6 "objectives completed (participation >= threshold at resolve)". The
-- plan doesn't pin a number; this picks the smallest meaningful credited
-- unit (matches game_objectives.lua's own PARTICIPATION_TICK_WEIGHT) rather
-- than inventing an arbitrary cutoff — any real, non-zero contribution counts.
local PARTICIPATION_OBJECTIVE_THRESHOLD = 1.0

local caretakerEnabled = false

-- Per-game state (E4: playerID reuse across games is a lobby/account
-- concern, not sim state — these tables are fresh Lua locals, reset
-- naturally every game the same way game_authority.lua's escrowState is).
local joinFrame      = {}   -- playerID -> frame first observed (tenure; survives reconnect)
local teamLeader      = {}   -- teamID -> playerID (OUR bookkeeping only, see header)
local earned          = {}   -- playerID -> lifetime authority earned (§6)
local spent           = {}   -- playerID -> lifetime authority spent from own pool (§6)
local objectivesDone  = {}   -- playerID -> count of objectives completed at/above threshold (§6)

-- ============================================================
-- Shared lookups (mirrors game_authority.lua's own playerTeam() pattern)
-- ============================================================
local function playerInfo(playerID)
    local _, active, spectator, teamID = Spring.GetPlayerInfo(playerID, false)
    return active, spectator, teamID
end

--- E2: "was an active player on a team" — the guard every callin below
--- runs first. Spectators have no team pools, no participation, and no
--- business in the leader/scoreboard machinery.
local function isPresent(playerID)
    local active, spectator, teamID = playerInfo(playerID)
    return active == true and spectator ~= true and teamID ~= nil
end

-- ============================================================
-- Co-commander coordinator (PLAN-metalstorm-ai.md §5/§5.1)
-- ============================================================
-- An AI virtual player sharing a team with a present human is a CO-COMMANDER:
-- it may spend only its OWN authority pool, never the team's shared savings
-- (§5 invariant). When the last human leaves, the AI becomes the team's
-- caretaker and reverts to full-side behaviour (may draw the team pool); when a
-- human rejoins it is a co-commander again (§5.1 up/downgrade). Both the synced
-- own-pool-only flag (driven below via GG.Authority.SetOwnPoolOnly) and the AI
-- VM's own goal-slate role (main.lua effectiveRole) key off the SAME published
-- fact — team_active_humans — so they cannot disagree.
--
-- isAI is surfaced ONLY through GetPlayerInfo's player-options table (the 11th
-- return, getPlayerOpts=true): opts.isAI == "1" for a virtual AI player
-- (LuaSyncedRead.cpp). The flat returns can't distinguish an AI from a human,
-- so a plain isPresent() check counts an AI as a "player" — we must inspect the
-- opts to split humans from AIs here.
local function isAIPlayer(playerID)
    local opts = select(11, Spring.GetPlayerInfo(playerID, true))
    return type(opts) == 'table' and opts.isAI == '1'
end

--- Recompute co-commander state for every team and publish it. Cheap (a couple
--- of GetPlayerList/GetPlayerInfo passes); called only when team human-presence
--- can change — GameStart + every join/leave.
local function refreshCoCommanders()
    local gaia = Spring.GetGaiaTeamID()
    for _, teamID in ipairs(Spring.GetTeamList()) do
        if teamID ~= gaia then
            local humans, ais = 0, nil
            for _, playerID in ipairs(Spring.GetPlayerList(teamID, true)) do
                if isPresent(playerID) then
                    if isAIPlayer(playerID) then
                        ais = ais or {}
                        ais[#ais + 1] = playerID
                    else
                        humans = humans + 1
                    end
                end
            end
            -- The AI VM reads this over the 'team' scope for its caretaker
            -- up/downgrade (main.lua teamHumans()).
            Spring.SetTeamRulesParam(teamID, 'team_active_humans', humans, ALLIED_LOS)
            -- Drive the synced own-pool-only invariant per AI on the team:
            -- humans present → co-commander (own pool only); none → caretaker /
            -- full-side (team fallback allowed). SetOwnPoolOnly is idempotent.
            if ais and GG.Authority and GG.Authority.SetOwnPoolOnly then
                for _, aiID in ipairs(ais) do
                    GG.Authority.SetOwnPoolOnly(aiID, humans > 0)
                end
            end
        end
    end
end

-- ============================================================
-- Leader policy (§5) — see the header note: this is bookkeeping only, never
-- an engine write. reassignLeader is idempotent (safe under E1 join/leave
-- interleaving) — it recomputes from current presence rather than
-- incrementing anything, so calling it twice in the same frame is a no-op
-- the second time.
-- ============================================================
local function reassignLeader(teamID)
    if not teamID then return end
    local current = teamLeader[teamID]
    if current and isPresent(current) then return end   -- still here, nothing to do

    local bestPlayer, bestFrame
    for _, playerID in ipairs(Spring.GetPlayerList(teamID, true)) do
        if isPresent(playerID) then
            local jf = joinFrame[playerID] or 0
            if not bestFrame or jf < bestFrame or (jf == bestFrame and playerID < bestPlayer) then
                bestPlayer, bestFrame = playerID, jf
            end
        end
    end

    if bestPlayer then
        teamLeader[teamID] = bestPlayer
        Spring.SetTeamRulesParam(teamID, 'team_leader', bestPlayer, ALLIED_LOS)
    end
    -- else: zero present players -> leader stays stale (§5 "Zero players:
    -- leader stays stale — harmless, nothing reads it except our own UI").
end

-- ============================================================
-- Joiner path (§3)
-- ============================================================
-- JOIN_GRANT mint + the authority_granted_<id> re-join guard already live
-- entirely in game_authority.lua's own PlayerAdded (task-teams-2: "coordinated
-- with authority task 7, already done") — duplicating that here would double
-- -grant. This gadget's joiner-path job is only the delta that's genuinely
-- its own: pointing the joiner at real team work (§3.3), no new objective
-- generated.
local function suggestObjective(playerID, teamID)
    if not GG.Objectives or not GG.Objectives.LowestParticipationTactical then return end
    local id = GG.Objectives.LowestParticipationTactical(teamID)
    if id and GG.Objectives.SuggestFor then
        GG.Objectives.SuggestFor(id, playerID)
    end
end

function gadget:PlayerAdded(playerID)
    local _, spectator, teamID = playerInfo(playerID)
    if spectator or not teamID then return end   -- E2

    if not joinFrame[playerID] then
        joinFrame[playerID] = Spring.GetGameFrame()
    end

    reassignLeader(teamID)      -- §5: a team with no present leader gets one
    suggestObjective(playerID, teamID)
    refreshCoCommanders()       -- §5.1: a human (re)joining downgrades an AI to co-commander
end

-- ============================================================
-- Leaver path (§4)
-- ============================================================
-- The authority pool merge (§4.1) is game_authority.lua's own PlayerRemoved.
-- The objective participation redirect (§4.2) needs NO code here at all —
-- distributeAward (game_objectives.lua) already filters participation
-- through isPlayerActive at resolve time, which is exactly "an inactive
-- player's accumulated weight redirects to the team pool"; it reads
-- Spring.GetPlayerInfo live, so it's correct the instant the engine marks a
-- player inactive, with nothing to sequence. This gadget's own job on a
-- leave is the social layer: leader reassignment (§5) and the caretaker-AI
-- activation hook (§4.5 — activation only, behaviour is PLAN-metalstorm-ai.md's).
local function maybeActivateCaretaker(teamID)
    if not caretakerEnabled then return end

    -- Only once the WHOLE side has emptied (§4.5) — a lone remaining
    -- teammate doesn't need a caretaker stepping on their orders.
    for _, playerID in ipairs(Spring.GetPlayerList(teamID, true)) do
        if isPresent(playerID) then return end
    end

    -- Activation only (task 3): the caretaker profile's actual behaviour is
    -- PLAN-metalstorm-ai.md §5/§10 task 4's job. No AI runtime exposes this
    -- hook yet (PLAN-metalstorm-ai.md's own AI0 blocker), so today this is a
    -- documented, defensive no-op — not a silent stand-in, an explicit one.
    if GG.AI and GG.AI.ActivateCaretaker then
        GG.AI.ActivateCaretaker(teamID)
    end
end

function gadget:PlayerRemoved(playerID, reason)
    -- Mirrors game_authority.lua's own PlayerRemoved lookup: Spring still
    -- resolves teamID/spectator for a just-removed playerID at this callin.
    local _, spectator, teamID = playerInfo(playerID)
    if spectator or not teamID then return end   -- E2

    reassignLeader(teamID)
    maybeActivateCaretaker(teamID)
    refreshCoCommanders()       -- §5.1: last human leaving upgrades the AI to caretaker
end

-- ============================================================
-- Scoreboard (§6) — earned/spent hooked into GG.Authority's award/charge
-- paths, objectives-completed hooked into GG.Objectives' resolve path.
-- Published on a slow cadence; the *team* wins or loses, this is social
-- recognition only (no end-game per-player payouts read these numbers).
-- ============================================================
local function creditEarned(playerID, _teamID, amount)
    if not playerID or not amount or amount <= 0 then return end
    earned[playerID] = (earned[playerID] or 0) + amount
end

local function creditSpent(playerID, _teamID, amount)
    if not playerID or not amount or amount <= 0 then return end
    spent[playerID] = (spent[playerID] or 0) + amount
end

--- §6 "objectives completed (participation >= threshold at resolve)". Only
--- credits players on the COMPLETING team (mirrors game_objectives.lua's
--- own distributeAward, which discards a wandering enemy's participation).
--- A departed player's weight stays in `o.participation` (§4.2) and
--- GetPlayerInfo still resolves their last-known team, so a teammate who
--- left before resolve still gets counted here — a lifetime stat, same as
--- earned/spent, deliberately not gated on still being present.
local function creditObjectiveComplete(o, completingTeam)
    if not o or not o.participation or not completingTeam then return end
    for playerID, w in pairs(o.participation) do
        if w and w >= PARTICIPATION_OBJECTIVE_THRESHOLD then
            local _, _, _, teamID = Spring.GetPlayerInfo(playerID, false)
            if teamID == completingTeam then
                objectivesDone[playerID] = (objectivesDone[playerID] or 0) + 1
            end
        end
    end
end

local function publishScoreboard()
    for _, playerID in ipairs(Spring.GetPlayerList()) do
        local p = 'score_' .. playerID .. '_'
        Spring.SetGameRulesParam(p .. 'earned', earned[playerID] or 0)
        Spring.SetGameRulesParam(p .. 'spent', spent[playerID] or 0)
        Spring.SetGameRulesParam(p .. 'objectives', objectivesDone[playerID] or 0)
    end
end

-- ============================================================
-- Lifecycle
-- ============================================================

function gadget:Initialize()
    -- Read modoptions here too (not just GameStart), mirroring
    -- game_authority.lua's own rationale: Initialize always runs (cold
    -- start + gadget reload), covering test scenes that skip GameStart.
    local mo = Spring.GetModOptions()
    -- Spring modoptions arrive as strings; bool options serialise as "1"/"0"
    -- (engine doc: LuaSyncedRead.cpp's GetModOptions comment — a plain
    -- truthy check on the string is NOT reliable).
    caretakerEnabled = tonumber(mo.ai_caretaker) == 1

    -- All gadget files are loaded before ANY gadget's Initialize() fires
    -- (see LOAD ORDER CONTRACT above), so GG.Authority/GG.Objectives are
    -- always present here despite GG.Objectives loading after this file.
    -- Guarded anyway, matching this codebase's optional-dependency style
    -- (GG.Regions checks elsewhere) — belt and suspenders, not a load-order
    -- workaround.
    if GG.Authority then
        if GG.Authority.OnAward then GG.Authority.OnAward(creditEarned) end
        if GG.Authority.OnCharge then GG.Authority.OnCharge(creditSpent) end
    end
    if GG.Objectives and GG.Objectives.OnComplete then
        GG.Objectives.OnComplete(creditObjectiveComplete)
    end
end

function gadget:GameStart()
    local mo = Spring.GetModOptions()
    caretakerEnabled = tonumber(mo.ai_caretaker) == 1

    -- Seed the initial roster through the same PlayerAdded path a mid-game
    -- joiner takes (mirrors game_authority.lua's own GameStart loop) — sets
    -- initial tenure + leader + starter suggestion for every starting player,
    -- not just drop-ins.
    for _, playerID in ipairs(Spring.GetPlayerList()) do
        gadget:PlayerAdded(playerID)
    end
    -- Establish the initial co-commander / caretaker split once the whole
    -- roster is seeded (PlayerAdded already refreshed per-join, but this
    -- guarantees every team is published even for a zero-drop-in start).
    refreshCoCommanders()
end

function gadget:GameFrame(frame)
    if frame % SCOREBOARD_PERIOD_FRAMES ~= 0 then return end
    publishScoreboard()
end
