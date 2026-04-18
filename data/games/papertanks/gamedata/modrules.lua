-- Paper Tanks: Game Rules
local modrules = {
    reclaim = {
        unitmethod = 0,
    },
    experience = {
        experiencemult = 0.5,
    },
    movement = {
        allowpushingalliedunits = true,
        allowcruising = true,
    },
    system = {
        pathfindertype = 0,  -- default pathfinder
    },
}
return modrules
