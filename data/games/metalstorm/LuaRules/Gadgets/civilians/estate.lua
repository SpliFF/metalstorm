-- civilians/estate.lua — the civilian estate as a parley party
-- (PLAN-metalstorm-interaction.md §3/§10 task 5).
-- Plain library module (NOT a gadget). Included by game_civilians.lua.
--
-- HOME NOTE: the interaction plan cites this bare as `civilians/estate.lua`;
-- its home is this existing civilians library folder
-- (LuaRules/Gadgets/civilians/), beside spawn/routines/convoy —
-- decision recorded in PLAN-metalstorm-structure.md.
--
-- The estate is a scripted responder to parley proposals addressed to the
-- civilian estate (toTeam resolves to Spring.GetGaiaTeamID() —
-- game_parley.lua's Propose() maps the 'civ' sentinel there), with simple
-- deterministic accept/refuse rules over the trust ledger + district state.
-- It also ORIGINATES protection contracts and reacts to credible threats
-- with a real (if simple) evacuation move.
--
-- SCOPE NOTE (matches objectives/generator.lua's own precedent comment):
-- civilians/spawn.lua's population seeding is still a stub (no map-authored
-- district placement — a separate, pre-existing civilians backlog item, not
-- this plan's scope) — so estate.threatenedDistricts() below is a REAL,
-- ready mechanism that currently sees no population and therefore yields
-- nothing. It is wired into objectives/generator.lua's districtRule the
-- moment population data exists; nothing here needs to change when it does.
local estate = {}

local CREDIBLE_THREAT_STRENGTH = 50    -- enemy HP-sum within THREAT_RADIUS to count as "credible" (§3)
local THREAT_RADIUS            = 600   -- elmos
local FLEE_DISTANCE             = 400   -- elmos, straight-line retreat from the threat position
local DISTRICT_PROTECT_REWARD   = 40    -- matches objectives/generator.lua's districtRule reward

-- ============================================================
-- Wire into the parley board (called from game_civilians.lua once
-- GG.Parley exists — layer -45 loads before civilians' -40).
-- ============================================================
function estate.register(civ)
    if not GG.Parley or not GG.Parley.OnPropose then return end
    GG.Parley.OnPropose(function(p)
        if p.toTeam == civ.gaiaTeam then
            estate.respond(civ, p)
        end
    end)
end

-- ============================================================
-- Threat credibility (§3 "a credible threat (attacker strength adjacent...)
-- triggers evacuation behaviour" — reused for both the parley responder's
-- accept/reject rule AND the demand->evacuation hook).
-- ============================================================
local function enemyStrengthNear(x, z, excludeTeam)
    local total = 0
    for _, unitID in ipairs(Spring.GetUnitsInCylinder(x, z, THREAT_RADIUS)) do
        local team = Spring.GetUnitTeam(unitID)
        if team and team ~= excludeTeam then
            total = total + (Spring.GetUnitHealth(unitID) or 0)
        end
    end
    return total
end

--- Is `fromTeam`'s military presence near (x,z) strong enough that its
--- demand/threat should be believed? Reuses a plain strength scan (the same
--- shape as objectives' ctx.teamStrengthInArea) — no pSuccess/intel model on
--- the synced side (that machinery is the AI's, unsynced); civilians judge
--- credibility on raw, visible-to-anyone strength.
local function isCredibleThreat(x, z, gaiaTeam)
    return enemyStrengthNear(x, z, gaiaTeam) >= CREDIBLE_THREAT_STRENGTH
end

--- The nearest non-Gaia unit's position within THREAT_RADIUS — the actual
--- point to flee AWAY FROM (evacuateDistrict needs a real threat position,
--- not the fleeing unit's own position).
local function nearestThreatPos(x, z, gaiaTeam)
    local bestUnit, bestDist
    for _, unitID in ipairs(Spring.GetUnitsInCylinder(x, z, THREAT_RADIUS)) do
        local team = Spring.GetUnitTeam(unitID)
        if team and team ~= gaiaTeam then
            local ux, _, uz = Spring.GetUnitPosition(unitID)
            if ux then
                local dx, dz = ux - x, uz - z
                local dist = dx * dx + dz * dz
                if not bestDist or dist < bestDist then bestDist, bestUnit = dist, unitID end
            end
        end
    end
    if not bestUnit then return nil end
    return Spring.GetUnitPosition(bestUnit)
end

-- ============================================================
-- Real (if simple) evacuation: flee straight-line away from the threat
-- position. GG.Regions has no centroid/geometry lookup yet (only
-- ControllingTeam/KeyAt/etc — confirmed absent), so "toward the nearest
-- safe region" isn't buildable today; a bounded retreat vector is a real,
-- working mechanism that doesn't wait on that geometry landing.
-- ============================================================
local function evacuateDistrict(district, threatX, threatZ)
    for _, unitID in ipairs(district.unitIDs) do
        local ux, uy, uz = Spring.GetUnitPosition(unitID)
        if ux then
            local dx, dz = ux - threatX, uz - threatZ
            local dist = math.sqrt(dx * dx + dz * dz)
            if dist > 0 then
                local fx = ux + dx / dist * FLEE_DISTANCE
                local fz = uz + dz / dist * FLEE_DISTANCE
                local fy = Spring.GetGroundHeight(fx, fz)
                Spring.GiveOrderToUnit(unitID, CMD.MOVE, { fx, fy, fz }, {})
            end
        end
    end
end

-- ============================================================
-- Rule-table evaluation (§3): one small, explicit rule per kind. Every
-- branch ends in a real GG.Parley.Respond call — no silent "does nothing".
-- ============================================================
function estate.respond(civ, proposal)
    local kind = proposal.kind
    local trust = GG.Parley.Trust(proposal.fromTeam, civ.gaiaTeam)

    if kind == 'ceasefire' then
        -- Civilians always want peace (§3 civilian estate rules).
        GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'accept')
        return
    end

    if kind == 'safe_passage' then
        -- Allow passage unless the proposer is already actively distrusted.
        if trust >= 0 then
            GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'accept')
        else
            GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'reject')
        end
        return
    end

    if kind == 'tribute' or (kind == 'demand' and proposal.terms.innerKind == 'tribute') then
        local t = (kind == 'demand') and proposal.terms.innerTerms or proposal.terms
        -- Pay only small, trust-neutral-or-better demands; the estate has no
        -- authority pool of its own (game_authority.lua's GameStart loop
        -- explicitly skips Gaia) so any nonzero payment the estate would
        -- owe fails at accept time regardless — a real, documented
        -- consequence of Gaia carrying no pool, not special-cased here.
        if trust >= 0 and (t.amount or math.huge) <= DISTRICT_PROTECT_REWARD then
            GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'accept')
        else
            GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'reject')
            estate.reactToRejectedDemand(civ, proposal)
        end
        return
    end

    if kind == 'demand' then
        -- Non-tribute demand (e.g. a bare ultimatum with no inner kind):
        -- the estate never capitulates to an unenforceable threat outright,
        -- but a credible one still triggers evacuation (§3/§4).
        GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'reject')
        estate.reactToRejectedDemand(civ, proposal)
        return
    end

    -- joint_objective / intel: civilians don't hold objectives or share
    -- military intel — refuse both, always.
    GG.Parley.Respond(proposal.id, civ.gaiaTeam, nil, 'reject')
end

--- Threat -> evacuation hook (§3/§4): a rejected demand whose proposer has
--- credible nearby strength makes the estate flee the affected units
--- immediately, rather than waiting for actual damage to land.
function estate.reactToRejectedDemand(civ, proposal)
    local regionKey = proposal.terms.regionKey
        or (proposal.terms.innerTerms and proposal.terms.innerTerms.regionKey)
    -- Locate a representative point for the threatened district: any
    -- populated unit currently in the named region (or, absent a region
    -- hint, any ambient civilian at all — a demand with no district scope
    -- still reads as a threat to the whole estate).
    for unitID, info in pairs(civ.population) do
        if info.role == 'ambient' then
            local x, _, z = Spring.GetUnitPosition(unitID)
            if x and (not regionKey or (GG.Regions and GG.Regions.KeyAt(x, z) == regionKey)) then
                if isCredibleThreat(x, z, civ.gaiaTeam) then
                    local tx, _, tz = nearestThreatPos(x, z, civ.gaiaTeam)
                    if tx then
                        evacuateDistrict({ unitIDs = { unitID } }, tx, tz)
                    end
                end
            end
        end
    end
end

-- ============================================================
-- Protection-contract origination (§3), wired to the ALREADY-BUILT
-- objectives/generator.lua districtRule (LuaRules/Gadgets/objectives/
-- generator.lua:128-148) via game_objectives.lua's civilianDistrictsUnderThreat()
-- world facade — this function IS that facade's real implementation.
-- ============================================================
function estate.threatenedDistricts(civ)
    local districts = {}
    for unitID, info in pairs(civ.population) do
        if info.role == 'ambient' and info.districtId then
            local d = districts[info.districtId]
            if not d then
                d = { districtId = info.districtId, unitIDs = {} }
                districts[info.districtId] = d
            end
            d.unitIDs[#d.unitIDs + 1] = unitID
        end
    end

    local out = {}
    for districtId, d in pairs(districts) do
        local x, _, z = Spring.GetUnitPosition(d.unitIDs[1])
        if x then
            local owner = GG.Regions and GG.Regions.KeyAt(x, z)
            owner = owner and GG.Regions.ControllingTeam(owner)
            if owner and isCredibleThreat(x, z, civ.gaiaTeam) then
                d.districtTeam = owner
                out[#out + 1] = d
            end
        end
    end
    return out
end

return estate
