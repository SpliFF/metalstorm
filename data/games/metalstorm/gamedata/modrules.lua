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
    -- WHAT MAY BE CARRIED (PLAN-metalstorm-transports.md §3.3).
    --
    -- These four are the engine's own gate on `cantBeTransported`, and they
    -- silently defaulted this game's whole roster to "cannot be lifted".
    -- UnitDef.cpp:594-603 ORs `cantBeTransported` from the passenger's
    -- movedef speedModClass against these flags, and ModInfo.cpp's defaults
    -- are transportGround=true with air/ship/hover all FALSE. Metalstorm's
    -- gamedata/moveinfo.tdf gives INFANTRY `speedmodclass=2` — Hover, chosen
    -- for its terrain behaviour, not because infantry hovers — so every
    -- soldier def in the game was untransportable, and SHIP/SUB with it.
    --
    -- Measured, not assumed: a headless arrival on `crossing_standoff` put 0
    -- of 2 squads aboard its Pelican, and `Spring.UnitAttach` reports that by
    -- doing nothing at all (CUnit::CanTransport returns false, no error, no
    -- log line). The gadget now WARNs on the count mismatch; this is the
    -- actual fix. Without it §3.3's arrivals can only ever deliver an empty
    -- transport, which makes the battle's one way to receive force a no-op.
    --
    -- `transportAir` stays FALSE deliberately: a carrier carrying a carrier is
    -- not a thing this game has any use for, and it is the one flag whose
    -- default is doing useful work.
    transportability = {
        transportGround = true,
        transportHover  = true,   -- INFANTRY is speedmodclass 2
        transportShip   = true,   -- the landing ship's own passengers, later
        transportAir    = false,
    },

    system = {
        pathfindertype = 0,
    },
}
return modrules
