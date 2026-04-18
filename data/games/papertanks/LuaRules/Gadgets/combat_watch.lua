-- combat_watch.lua — synced diagnostic gadget that gives per-second
-- visibility into combat state. Logs:
--   * a one-line team summary every second (living units, total HP)
--   * every UnitDamaged event that has a real attacker (filters out
--     self-damage from map gadgets like lava_physics)
--   * every UnitDestroyed event with the full attacker/weapon info
--
-- Leave enabled while bringing Paper Tanks combat up; remove or
-- gate behind a dev flag once the combat loop is stable. One
-- heartbeat line per second is negligible on the wire.

function gadget:GetInfo()
    return {
        name    = "Combat Watch",
        desc    = "Diagnostic — logs per-team combat stats and real damage events",
        author  = "spring-web",
        date    = "2026",
        license = "GPL v2",
        layer   = 0,
        enabled = true,
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

local spGetAllUnits           = Spring.GetAllUnits
local spGetUnitTeam           = Spring.GetUnitTeam
local spGetUnitHealth         = Spring.GetUnitHealth
local spGetUnitDefID          = Spring.GetUnitDefID
local spGetUnitPosition       = Spring.GetUnitPosition
local spGetUnitCurrentCommand = Spring.GetUnitCurrentCommand

local reportedFirstFrame = false

function gadget:GameFrame(frame)
    -- One-time per-unit snapshot at the first frame: position,
    -- weapon count, current command. This catches "units aren't
    -- moving" / "units have no weapons" problems directly.
    if not reportedFirstFrame and frame >= 1 then
        reportedFirstFrame = true
        for _, uid in ipairs(spGetAllUnits() or {}) do
            local team = spGetUnitTeam(uid)
            local udid = spGetUnitDefID(uid)
            local ud   = udid and UnitDefs and UnitDefs[udid]
            local name = ud and ud.name or "?"
            local numW = ud and ud.weapons and #ud.weapons or 0
            local x, y, z = spGetUnitPosition(uid)
            local cmd = spGetUnitCurrentCommand and spGetUnitCurrentCommand(uid) or nil
            Spring.Echo(string.format(
                "[combat] unit u%d team%d def=%s pos=(%.0f,%.0f,%.0f) weapons=%d cmd=%s",
                uid, team or -1, name,
                x or 0, y or 0, z or 0, numW,
                tostring(cmd)))
        end
    end

    -- One summary line per game second.
    if frame <= 0 or frame % 30 ~= 0 then return end

    local alive = {}
    local hp    = {}
    for _, uid in ipairs(spGetAllUnits() or {}) do
        local team = spGetUnitTeam(uid)
        if team then
            alive[team] = (alive[team] or 0) + 1
            local h = spGetUnitHealth(uid)
            hp[team] = (hp[team] or 0) + (h or 0)
        end
    end

    local parts = {}
    for team, n in pairs(alive) do
        parts[#parts + 1] = string.format("team%d=%d(hp=%d)", team, n, math.floor(hp[team] or 0))
    end
    table.sort(parts)
    -- Per-second team/hp summary silenced to keep the server log readable
    -- while debugging other subsystems. Re-enable if combat regressions
    -- start showing up again.
    -- Spring.Echo(string.format("[combat] t=%ds %s", frame / 30, table.concat(parts, " ")))

    -- Every 5 seconds, also dump one sample unit per team's position
    -- so we can see if they're moving toward each other.
    if frame % 150 == 0 then
        local seen = {}
        for _, uid in ipairs(spGetAllUnits() or {}) do
            local team = spGetUnitTeam(uid)
            if team and not seen[team] then
                seen[team] = true
                local x, _, z = spGetUnitPosition(uid)
                Spring.Echo(string.format(
                    "[combat]   sample team%d u%d pos=(%.0f,%.0f)",
                    team, uid, x or 0, z or 0))
            end
        end
    end

    -- One-time deep probe at ~5 seconds: for the first unit on each
    -- team, dump everything we can query about its weapon target
    -- state and enemy LoS state. This narrows down whether the
    -- problem is LoS, target acquisition, or downstream fire logic.
    if frame == 150 then
        local units = spGetAllUnits() or {}
        local firstOnTeam = {}
        for _, uid in ipairs(units) do
            local t = spGetUnitTeam(uid)
            if t and not firstOnTeam[t] then firstOnTeam[t] = uid end
        end
        for team, uid in pairs(firstOnTeam) do
            -- Weapon state
            local nWeapons = 0
            local targetType, targetVisible, targetID = nil, nil, nil
            if Spring.GetUnitWeaponTarget then
                targetType, targetVisible, targetID =
                    Spring.GetUnitWeaponTarget(uid, 1)
                nWeapons = 1
            end
            Spring.Echo(string.format(
                "[combat]   probe u%d(team%d) weaponTarget type=%s visible=%s target=%s",
                uid, team,
                tostring(targetType), tostring(targetVisible), tostring(targetID)))

            -- LoS to one enemy unit
            local enemyTeam = (team == 0) and 1 or 0
            local enemyUid = firstOnTeam[enemyTeam]
            if enemyUid and Spring.GetUnitLosState then
                -- The "raw" allyTeam form returns a table like
                -- { los=true, radar=true, prevLos=true, contRadar=true }
                -- (each key is present only if that flag is set).
                -- We need the *enemy's* ally team perspective, so
                -- pass team (the observer) as the ally argument.
                local obsAllyTeam = team -- team == allyTeam in our 2-team setup
                local ls = Spring.GetUnitLosState(enemyUid, obsAllyTeam, false)
                local parts = {}
                if type(ls) == "table" then
                    for k, v in pairs(ls) do
                        parts[#parts + 1] = tostring(k) .. "=" .. tostring(v)
                    end
                elseif type(ls) == "number" then
                    parts[#parts + 1] = "bits=" .. tostring(ls)
                end
                Spring.Echo(string.format(
                    "[combat]   u%d(team%d) sees enemy u%d? los={%s}",
                    uid, team, enemyUid, table.concat(parts, ",")))

                -- Also print distance between them so we know they
                -- should be in range.
                local ax, _, az = spGetUnitPosition(uid)
                local bx, _, bz = spGetUnitPosition(enemyUid)
                if ax and bx then
                    local d = math.sqrt((ax - bx)^2 + (az - bz)^2)
                    Spring.Echo(string.format(
                        "[combat]   distance u%d <-> u%d = %.0f elmos",
                        uid, enemyUid, d))
                end
            end
        end
    end
end

function gadget:UnitDamaged(unitID, unitDefID, unitTeam,
                            damage, paralyzer,
                            weaponDefID, projectileID,
                            attackerID, attackerDefID, attackerTeam)
    -- We only care about combat damage (real attacker). Filter out
    -- lava/self-damage and other environmental hits, which have a
    -- nil attackerID.
    if not attackerID then return end
    Spring.Echo(string.format(
        "[combat] DAMAGE u%d(team%d) <- u%d(team%d) wpn=%s dmg=%.0f",
        unitID, unitTeam or -1,
        attackerID, attackerTeam or -1,
        tostring(weaponDefID),
        damage or 0))
end

function gadget:UnitDestroyed(unitID, unitDefID, unitTeam,
                              attackerID, attackerDefID, attackerTeam, weaponDefID)
    Spring.Echo(string.format(
        "[combat] DEATH u%d(team%d) attacker=%s team=%s wpn=%s",
        unitID, unitTeam or -1,
        tostring(attackerID or "nil"),
        tostring(attackerTeam or "nil"),
        tostring(weaponDefID or "nil")))
end
