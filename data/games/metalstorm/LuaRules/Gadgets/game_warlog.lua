-- game_warlog.lua — the strategic event log of a persistent war
-- (PLAN-persistence.md §4 "while-you-were-away digest", task 4b).
--
-- A week-long war is played in sessions. A player who closes the browser on
-- Tuesday and comes back on Friday has no way to learn what happened to their
-- world in between: the board they log back into states only the CURRENT
-- ownership, the CURRENT objectives and the CURRENT pacts. This gadget is the
-- emit half of the answer — one ring of strategic events, drained by the game
-- server's war-summary heartbeat into the shared `game_events` table, read
-- back by the lobby as the digest a returning player is shown before they
-- click Join.
--
-- ── Why a ring and not a list ──────────────────────────────────────────────
-- Same reason game_authority.lua's award ring is a ring: rulesParams are
-- synced state, so an unbounded log would grow the sync surface (and every
-- snapshot) for the life of a war that is DESIGNED to run for weeks. The ring
-- is a hand-off buffer, not the record — the record is the DB table, and the
-- server drains this ring every 2 s. WARLOG_RING_SIZE is 32 rather than the
-- toast rings' 8 because nothing here is a toast: a region cascade at
-- GameStart can flip a dozen keys in one eval tick, and the drain's whole
-- correctness claim is "no strategic event is silently lost".
--
-- ── Why NOT public ────────────────────────────────────────────────────────
-- The toast rings are read by widgets and are (implicitly) private already;
-- this one is read only by the C++ heartbeat, which sees every synced param
-- regardless. Publishing it would stream one side's pact history to the
-- other, which the parley design deliberately does not do.
--
-- ── The seq is the contract ───────────────────────────────────────────────
-- `warlog_seq` is monotonic for the life of the WAR, not of the process: it
-- rides gameRulesParams into the snapshot, and this gadget's Save/Load carries
-- the Lua-side cursor with it. That is what lets the server-side drain hold a
-- "last drained" watermark across a hibernate/resume — and what lets it
-- notice, on the far side, that N events were overwritten while it was not
-- looking (seq jumped by more than the ring holds) instead of reporting a
-- shorter history as a complete one.

function gadget:GetInfo()
    return {
        name    = "War Log",
        desc    = "Strategic event ring drained into the persistent war digest",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -99, -- after authority (-100), before objectives/regions/parley
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local WARLOG_RING_SIZE = 32

-- Bound on what any one field costs the sync surface. A subject is a region
-- name or an objective type, both authored; the clamp exists so a scenario
-- with a pathological name cannot make every snapshot bigger, not because any
-- shipped content is near it.
local MAX_FIELD = 64

local eventSeq = 0

GG.WarLog = GG.WarLog or {}

local function clamp(s)
    s = tostring(s or '')
    if #s > MAX_FIELD then return s:sub(1, MAX_FIELD) end
    return s
end

--- Record one strategic event.
---   kind    — the class the reader switches on: 'objective' | 'region' | 'pact'.
---   subject — the display noun, composed by the EMITTER (a region's authored
---             name, an objective's type). The lobby and the client never
---             re-derive it; they have no access to the sim that knows it.
---   detail  — the outcome within the kind ('complete' | 'captured' | 'broken' …).
---   team    — the team the event happened FOR (who took it, who broke it).
---             -1 for an event with no owning side.
---
--- Returns the seq it was written at, so a caller can order its own logging
--- against the drain. Never throws: an emit is an observation, and a war must
--- not die because a digest line could not be composed.
function GG.WarLog.Emit(kind, subject, detail, team)
    eventSeq = eventSeq + 1
    local slot = eventSeq % WARLOG_RING_SIZE
    local p = 'warlog_' .. slot .. '_'
    Spring.SetGameRulesParam(p .. 'kind', clamp(kind))
    Spring.SetGameRulesParam(p .. 'subject', clamp(subject))
    Spring.SetGameRulesParam(p .. 'detail', clamp(detail))
    Spring.SetGameRulesParam(p .. 'team', tonumber(team) or -1)
    Spring.SetGameRulesParam(p .. 'frame', Spring.GetGameFrame())
    Spring.SetGameRulesParam(p .. 'seq', eventSeq)
    -- Written LAST: the drain reads the head first and then walks back over
    -- the slots, so a head published before its own slot would hand the
    -- server a half-written event.
    Spring.SetGameRulesParam('warlog_seq', eventSeq)
    return eventSeq
end

-- ── The balance-patch digest (PLAN-def-reconciliation §2 step 6, task 4) ──
--
-- The one thing a returning player cannot possibly work out for themselves.
-- Every other digest line reports something that HAPPENED IN THE WAR; this one
-- reports that the war's own rules moved between two sessions, which is why
-- their veteran armour has a different health bar and why the objective they
-- left running is gone. Without it the reconcile pass is invisible to exactly
-- the person it happened to.
--
-- HOW MANY EVENTS, AND THE CAP IS NOT COSMETIC. A patch that removes 50 unit
-- defs would emit 50 events into a 32-slot ring and lap it, destroying the
-- strategic history the digest exists for — the patch note would eat the war.
-- So the per-def lines are capped and a summary always follows, carrying the
-- true totals; the drain's own elision reporting stays intact because the ring
-- never laps from this. The cap is stated in the log line, not silent.
local PATCH_DEF_LINES = 4

function gadget:DefsReconciled(delta)
    if not delta then return end
    local counts = delta.counts or {}
    local removed = (delta.units and delta.units.removed) or {}

    -- Only the removals that actually cost this war something are named: a def
    -- deleted from the game that this war never fielded is not news to anybody
    -- who played it. `unitsDropped` is the count that says it cost something.
    local named = 0
    if (counts.unitsDropped or 0) > 0 then
        for _, defName in ipairs(removed) do
            if named >= PATCH_DEF_LINES then break end
            GG.WarLog.Emit('patch', defName, 'removed', -1)
            named = named + 1
        end
    end

    -- The summary is emitted unconditionally, INCLUDING when nothing this
    -- gadget can phrase moved: the engine only fires this call-in when the defs
    -- really did move, so "a patch landed and touched nothing you can see" is
    -- still the answer to "why did the game restart on me".
    local parts = {}
    local function part(n, one, many)
        n = tonumber(n) or 0
        if n > 0 then parts[#parts + 1] = n .. ' ' .. (n == 1 and one or many) end
    end
    part(counts.unitsAdjusted, 'unit retuned', 'units retuned')
    part(counts.unitsDropped, 'unit lost', 'units lost')
    part(counts.featuresDropped, 'wreck lost', 'wrecks lost')
    part(counts.ordersDeactivated, 'order stood down', 'orders stood down')
    local subject = (#parts > 0) and table.concat(parts, ', ') or 'no visible change'
    GG.WarLog.Emit('patch', subject, 'summary', -1)

    Spring.Log('warlog', LOG.NOTICE, string.format(
        'defs reconciled: digest carries %d of %d removed unit def(s) plus a '
        .. 'summary [%s]', named, #removed, tostring(delta.digest)))
end

--- The ring size, published once so the server-side drain reads the buffer's
--- real geometry rather than a constant compiled into two places.
function gadget:Initialize()
    Spring.SetGameRulesParam('warlog_ring', WARLOG_RING_SIZE)
    Spring.SetGameRulesParam('warlog_seq', eventSeq)
end

-- ─────────────── Snapshot state (PLAN-persistence §7.1) ───────────────
--
-- CAPTURED — `eventSeq`, for the same reason game_authority.lua captures its
-- own: the ring slots ARE rulesParams and are restored with the world, so a
-- cursor reset to 0 would overwrite the newest event next and re-publish a seq
-- the server has already drained — the digest would then either duplicate
-- those events or (once the watermark is ahead) drop every event of the
-- resumed war until the seq caught back up. This is the one field here.
function gadget:Save(state)
    state.eventSeq = eventSeq
end

function gadget:Load(state)
    eventSeq = tonumber(state.eventSeq) or 0
    Spring.SetGameRulesParam('warlog_seq', eventSeq)
end
