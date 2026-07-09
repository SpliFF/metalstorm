-- Metalstorm game rules.
-- Slow-build, team-shared, authority-driven (PLAN-metalstorm.md §4, §8).
local modrules = {
    reclaim = {
        unitmethod = 0,
        allowenemies = false,
    },
    experience = {
        experiencemult = 0.5,
    },
    movement = {
        allowpushingalliedunits = true,
        allowcruising = true,
    },
    construction = {
        -- Construction is time-gated, not resource-gated (authority is spent
        -- at order time, not per build tick). Decay off: half-built military
        -- works are persistent commitments.
        constructiondecay = false,
    },
    system = {
        pathfindertype = 0,
    },
}
return modrules
