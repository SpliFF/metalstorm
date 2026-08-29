-- squad_extents_spec.lua — unit-motion M3, the sim half of USER-REPORTED
-- 2026-08-29: "units visually overlap each other, within squads and BETWEEN
-- them."
--
-- M2 fixed the within case and measured the between case as real (two
-- `ms_tanks_s2` squad units 32.5 elmos apart while each squad draws 289 elmos
-- wide). M3's finding is that the knob is `separationDistance`, not
-- `footprintx/z` — and that the value to feed it depends on how wide the
-- CLIENT draws the formation. `_builder.lua` therefore carries a Lua port of
-- `client/squads/formation.js`'s slot templates.
--
-- Two ports of the same geometry is a drift hazard, so this spec is one half of
-- the pin: the golden extents below are asserted here against the Lua port and
-- in `client/squads/member-spacing.test.js` against formation.js itself. A
-- template edited on one side only fails one of the two.
--
-- Runs from EITHER of the two working directories the suite is driven from:
--   cd data/games/metalstorm            && busted LuaRules/Gadgets/tests/
--   cd data/games/metalstorm/LuaRules/Gadgets && busted tests/
-- Its neighbours are split between the two conventions and each errors out
-- under the other one; this spec resolves the game root itself instead, so it
-- contributes results rather than cwd noise whichever way the suite is run.

-- The builder is normally reached through the engine's VFS. Stub just enough
-- of it that a unit class file loads in a bare lua_State. `VFS.Include` is
-- given game-root-relative paths ('units/_builder.lua'), so the stub has to
-- resolve them the same way `loadClass` does.
local GAME_ROOT = (function()
    for _, prefix in ipairs({ '', '../../', '../../../' }) do
        local f = io.open(prefix .. 'units/_builder.lua', 'r')
        if f then f:close(); return prefix end
    end
    error('cannot find the metalstorm game root from ' .. (os.getenv('PWD') or '?'))
end)()

_G.VFS = _G.VFS or {}
VFS.Include = function(path) return dofile(GAME_ROOT .. path) end

local function loadClass(name)
    return dofile(GAME_ROOT .. 'units/' .. name .. '.lua')
end

-- ── The golden table ───────────────────────────────────────────────────────
-- def -> the ground radius it covers on screen, in elmos. Same numbers as
-- `M3_SQUAD_EXTENTS` in member-spacing.test.js, derived there from formation.js.
local GOLDEN_OUTER_RADIUS = {
    ms_tanks_s1     = 135, ms_tanks_s2     = 145, ms_tanks_s3   = 126,
    ms_soldiers_s1  =  55, ms_soldiers_s2  =  37,
    ms_artillery_s1 = 163, ms_artillery_s2 = 134,
    ms_mechs_s1     =  53, ms_engineers_s1 =  27,
    ms_civilians    =  17, ms_ships_s1     = 448, ms_subs_s3    = 594,
}

-- Mobile-vs-mobile collision floor DIAMETER the engine already applies, per
-- movement class — MoveDef::xsize from gamedata/moveinfo.tdf. Restated here
-- rather than imported so that a change to either copy fails this spec.
local FLOOR = { INFANTRY = 8, VEH = 24, HEAVY = 56, SHIP = 56, SUB = 40 }

local CLASS_OF = {
    ms_tanks_s1 = 'tanks', ms_tanks_s2 = 'tanks', ms_tanks_s3 = 'tanks',
    ms_tanks_s4 = 'tanks', ms_soldiers_s1 = 'soldiers', ms_soldiers_s2 = 'soldiers',
    ms_soldiers_s4 = 'soldiers', ms_artillery_s1 = 'artillery',
    ms_artillery_s2 = 'artillery', ms_mechs_s1 = 'mechs',
    ms_engineers_s1 = 'engineers', ms_civilians = 'civilians',
    ms_ships_s1 = 'ships', ms_subs_s3 = 'subs',
}

local cache = {}
local function def(name)
    local class = CLASS_OF[name] or error('no class mapped for ' .. name)
    cache[class] = cache[class] or loadClass(class)
    return cache[class][name] or error('no def ' .. name)
end

describe("squad ground extent (the Lua port of formation.js)", function()

    it("reproduces formation.js's packed extent for every golden def", function()
        for name, expected in pairs(GOLDEN_OUTER_RADIUS) do
            local got = tonumber(def(name).customparams.squad_footprint_radius)
            assert.is_not_nil(got, name .. ' emitted no squad_footprint_radius')
            assert.are.equal(expected, got,
                name .. ': Lua port says ' .. tostring(got) ..
                ', member-spacing.test.js says ' .. expected ..
                ' — the two formation ports have drifted')
        end
    end)

    it("measures a single hull as its own clearance, with no formation involved", function()
        -- Scale 4 is one super-heavy model. `ms_tanks_s4` declares a 13 m hull,
        -- so 104 elmos of radius and not a slot in sight.
        assert.are.equal(104, tonumber(def('ms_tanks_s4').customparams.squad_footprint_radius))
    end)

    it("treats scale 4 as a single hull even when the squad curve says otherwise", function()
        -- The regression this pins: `squad_size` used to be forced to 1 AFTER
        -- the blocks that branch on it, so `ms_soldiers_s4` (curve: 2) was
        -- measured as a two-slot line — 72 elmos of radius for a def that
        -- draws one model.
        assert.are.equal('1', def('ms_soldiers_s4').customparams.squad_size)
        assert.are.equal(4, tonumber(def('ms_soldiers_s4').customparams.squad_footprint_radius))
    end)
end)

describe("between-squad separation", function()

    it("asks for a gap two squads stand clear in, net of the MoveDef floor", function()
        for name, radius in pairs(GOLDEN_OUTER_RADIUS) do
            local d = def(name)
            if d.movementclass then
                local want = 2 * radius - FLOOR[d.movementclass]
                assert.are.equal(want, d.separationDistance,
                    name .. ' separationDistance')
            end
        end
    end)

    it("closes the gap the milestone was opened for", function()
        -- The measured defect: two `ms_tanks_s2` squad units sat 32.5 elmos
        -- apart. The floor the engine applied on its own was the VEH MoveDef's
        -- 12 + 12 = 24 elmos, which is why nothing parted them.
        local d = def('ms_tanks_s2')
        local floorOnly = FLOOR.VEH
        assert.is_true(floorOnly < 33, 'the pre-M3 floor really was below the measured 32.5')
        assert.are.equal(2 * 145, floorOnly + d.separationDistance,
            'two tank squads now stand a full formation apart')
    end)

    it("leaves aircraft alone — separationDistance is read only by GroundMoveType", function()
        -- Not an oversight: a def with no movementclass has no MoveDef, and
        -- `UnitDef::separationDistance` is consumed exclusively in
        -- GroundMoveType.cpp. Emitting it on a bomber would be dead data.
        local bombers = loadClass('bombers')
        assert.is_nil(bombers.ms_bombers_s1.movementclass)
        assert.is_nil(bombers.ms_bombers_s1.separationDistance)
        -- ...but the extent is still measured, so a future air fix has it.
        assert.are.equal(290, tonumber(bombers.ms_bombers_s1.customparams.squad_footprint_radius))
    end)

    it("does not touch footprintx/z — that is the ground-blocking yardmap, not the reservation", function()
        -- The whole point of M3's measurement. `ms_tanks_s1` still reserves the
        -- generic 2 cells: widening it to the ~17 its formation implies would
        -- mark a 272-elmo square blocked for every other unit (3.1x the widest
        -- town main street) and would not part two squads by one elmo, because
        -- mobile-vs-mobile collision reads the MoveDef.
        assert.are.equal(2, def('ms_tanks_s1').footprintx)
        assert.are.equal(2, def('ms_tanks_s1').footprintz)
    end)
end)
