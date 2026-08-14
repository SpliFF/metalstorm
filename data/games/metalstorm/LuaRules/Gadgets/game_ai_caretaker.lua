-- game_ai_caretaker.lua — seat a caretaker AI on a side whose last human left
-- (PLAN-metalstorm-ai.md §10 task 4(b); PLAN-metalstorm-teams.md §4.5).
--
-- This is the OTHER half of the caretaker rule. game_teams.lua owns the social
-- decision — "the whole side has emptied" — and calls
-- `GG.AI.ActivateCaretaker(teamID)`; until now nothing answered that call, and
-- the hook was a documented no-op. Two cases were always covered and are NOT
-- this file's business:
--
--   * a side that already HAS an AI: it upgrades itself from co-commander to
--     the full-side goal the moment the humans are gone (game_teams.lua's
--     refreshCoCommanders + the AI's own roles.lua). Nothing to spawn.
--   * `ai_caretaker` off (the default): game_teams never calls at all.
--
-- What is new is the third case — a side that never had an AI. Seating one
-- needs the AI runtime, which is the server's, so this gadget declares through
-- `Spring.SpawnAIPlayer` (a fork addition; see rts/Server/AI/AISpawn.h for the
-- FIDELITY-STANDIN note and the replay argument) and the server decides on its
-- next tick. The declaration is not a seating: the server refuses a team that
-- gained an AI in the meantime, and says so in its own log.
--
-- THE PROFILE IS PUBLISHED HERE, NOT PASSED THROUGH THE ENGINE. The AI VM
-- reads its personality off the team rulesParam `ai_profile` /
-- `ai_profile_<playerID>` (ai/strategos/picture.lua readProfileHint), which is
-- synced state this gadget can simply write — so the caretaker's profile never
-- leaves synced Lua and the engine surface stays one function of two
-- arguments. Written BEFORE the request, so the VM's first tick already sees
-- it; team-scoped rather than player-scoped because the caretaker takes over
-- the whole abandoned side and its playerID does not exist yet.
--
-- KNOWN LIMITATION, stated rather than hidden: a caretaker seated mid-war does
-- not survive hibernate/resume. The war's AI slots are `--ai` arguments the
-- lobby passes at launch, and nothing writes a runtime-spawned AI back into
-- that room record, so a resumed war comes back with the caretaker's virtual
-- player in the restored roster (it is captured synced state) and no runtime
-- behind it. Making it durable is a lobby/RoomManager change — filed in
-- PLAN-metalstorm-ai.md §10 task 4(b), not worked around here.
--
-- LOAD ORDER CONTRACT: layer -94 — after game_teams (-95), which is the only
-- caller, and after authority (-100) whose pool the seated AI will draw on.

function gadget:GetInfo()
    return {
        name    = "AI Caretaker",
        desc    = "Seats a caretaker AI on a side whose last human has left",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -94,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

GG.AI = GG.AI or {}

-- The plugin the caretaker is seated from: `data/games/metalstorm/ai/strategos`
-- (AIDiscovery ids are folder names). A constant rather than a modoption on
-- purpose — an option whose value can name a plugin that does not exist buys
-- a failure mode ("the caretaker silently never arrives") in exchange for a
-- choice nobody has asked to make. Metalstorm ships one brain.
local CARETAKER_AI_ID   = 'strategos'
-- profiles/caretaker.lua — the role's own parameters (PLAN-metalstorm-ai §5).
local CARETAKER_PROFILE = 'caretaker'

-- Same LOS scope game_teams.lua publishes `ai_profile_<id>` with: allies may
-- read it. This is a personality label, not a plan.
local ALLIED_LOS = { allied = true }

-- teamID -> true once a request has been accepted for that side. Two reasons
-- it is needed: the caretaker hook fires from PlayerRemoved, which runs for
-- EVERY leaver on an emptying side (a three-player side emptying calls three
-- times), and the engine's own "this team already has an AI" check cannot see
-- a request that has been queued but not yet drained.
local requested = {}

local warnedNoEngineSupport = false

--- §4.5 — hand an abandoned side to a caretaker AI.
--- Returns true when a request was accepted by the server's relay. False means
--- "no request was made", for a reason that is always named in the log: the
--- side still has an AI, one is already queued, or this server binary has no
--- spawn surface at all.
function GG.AI.ActivateCaretaker(teamID)
    if teamID == nil then return false end
    teamID = math.floor(teamID)

    if requested[teamID] then return false end

    -- The upgrade-in-place case. GG.Teams.AIPlayers filters to PRESENT AI
    -- players on the team, which is exactly the population that would contend
    -- with a second brain for one authority pool and one set of org groups.
    if GG.Teams and GG.Teams.AIPlayers then
        local existing = GG.Teams.AIPlayers(teamID)
        if existing and #existing > 0 then
            Spring.Log('ai-caretaker', LOG.INFO,
                ('team %d emptied but already has an AI (player %d) — it takes ' ..
                 'the side over in place, no spawn'):format(teamID, existing[1]))
            return false
        end
    end

    -- No silent stand-in: a server binary older than the spawn hook simply has
    -- no such function, and a caretaker that never arrives must not look like
    -- a caretaker that arrived and did nothing.
    if type(Spring.SpawnAIPlayer) ~= 'function' then
        if not warnedNoEngineSupport then
            warnedNoEngineSupport = true
            Spring.Log('ai-caretaker', LOG.WARNING,
                'Spring.SpawnAIPlayer is missing from this engine build — ' ..
                'the ai_caretaker modoption is on but no side can be handed over')
        end
        return false
    end

    -- Ahead of the request: the VM reads its profile on its first tick, which
    -- is the tick after the server drains this.
    Spring.SetTeamRulesParam(teamID, 'ai_profile', CARETAKER_PROFILE, ALLIED_LOS)

    if not Spring.SpawnAIPlayer(teamID, CARETAKER_AI_ID) then
        Spring.Log('ai-caretaker', LOG.WARNING,
            ('caretaker spawn request for team %d was refused at declaration ' ..
             '(invalid team, or one is already queued)'):format(teamID))
        return false
    end

    requested[teamID] = true
    Spring.Log('ai-caretaker', LOG.NOTICE,
        ('team %d has no humans left — requested a %s caretaker (%s)')
            :format(teamID, CARETAKER_PROFILE, CARETAKER_AI_ID))
    return true
end

-- Snapshot state (PLAN-persistence task 1d): `requested` is a fuse, and a
-- restore that forgot it would re-declare on the next leaver — harmless
-- (the server refuses a team that already has an AI) but it would log a
-- refusal every time and mask a real one.
function gadget:Save(state)
    state.requested = requested
end

function gadget:Load(state)
    requested = state.requested or {}
end
