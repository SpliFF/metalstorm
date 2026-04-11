-- Paper Tanks Basic AI
-- Sends idle units to attack the nearest visible enemy.

function onUpdate(frame)
    local myUnits = AI.getOwnUnits()
    local enemies = AI.getVisibleEnemies()

    if #enemies == 0 then return end

    for _, unit in ipairs(myUnits) do
        if not unit.hasCommands then
            -- Find nearest enemy
            local nearest = nil
            local nearestDist = math.huge

            for _, enemy in ipairs(enemies) do
                local dx = enemy.x - unit.x
                local dz = enemy.z - unit.z
                local dist = dx * dx + dz * dz
                if dist < nearestDist then
                    nearestDist = dist
                    nearest = enemy
                end
            end

            if nearest then
                -- CMD_ATTACK = 20, target unit ID as param
                AI.issueCommand(unit.id, 20, nearest.id)
            end
        end
    end
end
