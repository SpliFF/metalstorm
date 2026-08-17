-- features/bridges.lua — tileable crossing spans (PLAN-metalstorm-model-integration §M3).
--
-- See features/README.md for the load path and the key table.
--
-- ============================================================================
-- WHY THESE ARE NON-BLOCKING (the §M3 "pathable on top" ask, answered)
-- ============================================================================
-- M3 asks for bridges that units path across ON TOP of while the span blocks
-- underneath. **The engine cannot express that, and the gap is not in these
-- defs.** Spring/Recoil pathing is single-layer: `CFeature::Block()`
-- (rts/Sim/Features/Feature.cpp:237) either stamps the footprint into the
-- ground-blocking map or it does not. There is no deck height, no over/under,
-- no multi-level nav mesh. The one permeability mechanism this fork added —
-- `FootprintProfileHandler`'s `underpass` move-class lists
-- (rts/Sim/MoveTypes/FootprintProfile.cpp) — hangs off `UnitDef`
-- (rts/Sim/Units/UnitDef.h:266) and is never consulted for a feature.
--
-- So the choice is binary, and `blocking = false` is the right half of it:
--
--   blocking = true   a bridge is a WALL across the gap it exists to open.
--                     Every unit routes around the crossing. This is strictly
--                     worse than no bridge at all.
--   blocking = false  a cosmetic span. Units cross wherever the TERRAIN is
--                     already passable, and the bridge is the visual + narrative
--                     explanation of the crossing. Chokepoint gameplay comes
--                     from the terrain the bridge is placed on, which is where
--                     scenariogen controls it anyway.
--
-- The engine ask is filed in .tasks/notes/model-integration.md (2026-08-06):
-- either a `deckHeight` featuredef field that raises the blocking map's
-- sampled Y over the footprint, or extending the FootprintProfile permeability
-- query to features. When that lands, flipping `blocking` here is a one-line
-- change and the models/footprints below need no revision.
--
-- ============================================================================
-- THE DECK GAP IS A MODEL CONSTANT, NOT A TERRAIN ONE (roads R3c, 2026-08-15)
-- ============================================================================
-- Every span in this file is authored with its ORIGIN AT THE PIER BASE: the
-- shipped glTF runs y = 0.00 .. 4.52 (road) and 0.00 .. 4.15 (rail), measured
-- off the mesh, so the trafficable surface sits `deck_top` ABOVE the model's
-- own y = 0. And `CFeature::UpdatePosition` ends every tick with
--
--   Move(UpVector * (max(CGround::GetHeightReal(x, z), pos.y) - pos.y))
--   (Feature.cpp:570)
--
-- — a feature's y is clamped UP to the ground and can never be pushed down.
-- So a unit driving at the terrain height under a span is ALWAYS exactly
-- `deck_top` below the deck it should be driving on, and **raising the terrain
-- raises the span with it**: the gap is invariant under every earthwork a map
-- generator can do. It is closed by moving the model origin to the deck
-- surface, or by the `deckHeight` engine ask above — never by terrain alone.
-- PLAN-maps.md §2j has the options; the note below in `span()` about "terrain
-- shaped to carry it" was written before this was measured and is wrong.
--
-- `deck_top` is published PER DEF (not in the shared `span()` posture) because
-- the two spans do not agree: the road deck is a slab at 1.50 and the rail
-- deck is 3.80 with the rail head at 4.15. A single shared number would be
-- wrong for one of them, silently.
--
-- ============================================================================
-- CHAINING — the acceptance criterion, and why 24.0 exactly is safe
-- ============================================================================
-- Both spans are authored as tileable segments on their local Z (RH, -Z
-- forward). Measured off the shipped glTF:
--
--   ms_road_bridge   Z -12.00 .. +12.00   exactly 24.00 m
--   ms_rail_bridge   Z -12.041 .. +12.041      24.08 m
--
-- Chain pitch is therefore exactly **24.0** for both, published as
-- `customparams.chain_pitch` so placement code has one source of truth
-- (game_scenario.lua's `world.features` `chain` field reads it).
--
-- The rail span's extra 41 mm per end is 16 vertices at y=2.906, x=+-1.74..1.86
-- — the rail heads, overhanging on purpose so a chained line of segments reads
-- as continuous rail. At a 24 m pitch neighbouring rail heads interpenetrate by
-- 82 mm: solid inside solid, no coplanar pair, no z-fighting.
--
-- The road span carries 14 deck cross-section cap triangles on each end plane.
-- Chained at 24 m, segment A's +Z caps and segment B's -Z caps are coincident —
-- but ANTIPARALLEL, and both materials are single-sided (`doubleSided` is unset
-- in the glTF). Whichever one faces the camera is the only one drawn, and it
-- sits inside the neighbour's solid, so there is no coincident same-facing pair
-- to fight. `tools/forge/samples/ms_road_bridge/ms_road_bridge_layout.py:5`
-- states the intent: "deck runs exactly z = -12..+12 at full width at both ends
-- so segments chain seamlessly".
--
-- Do NOT "fix" the seam by nudging the pitch off 24. A 23.9 m pitch would
-- overlap the decks and put the two deck TOP surfaces — which are coplanar,
-- same-facing and textured — into genuine z-fighting. The current geometry is
-- only safe because the coincident faces point away from each other.

--- Shared span posture. Cosmetic scenery: no blocking (see the header), no
--- selecting, and indestructible so a stray shell cannot delete a span while
--- the terrain crossing it explains stays right where it was.
local function span(t)
    t.blocking       = false
    t.noselect       = true
    t.indestructible = true            -- implies reclaimable = false; correct, a bridge is not scrap
    t.flammable      = false
    t.upright        = true
    -- FLOATING IS NOT COSMETIC HERE — it is the only way a span keeps a level
    -- deck. Features are not fixed in the air: CFeature::UpdatePosition applies
    -- gravity every tick and then clamps to
    -- `max(CGround::GetHeightReal(x, z), pos.y)` (Feature.cpp:565-571), so the
    -- y a scenario passes to Spring.CreateFeature is a SPAWN height that the
    -- feature immediately settles out of. Live-measured 2026-08-06: four road
    -- spans placed at y = 0 over a skerry_reach channel came to rest at
    -- -31.0 / -34.5 / -45.9 / -57.6 — a staircase down the seabed, which is
    -- exactly what a bridge must not be.
    --
    -- `floating` zeroes the gravity term while the feature is in water
    -- (Feature.cpp:533, `gravAccel * (1 - def->floating)`), so a span spawned
    -- at the waterline STAYS at the waterline and the chain stays level. That
    -- covers the case §M4 actually wants ("bridges over water gaps —
    -- scorched_crossing is the natural first map").
    --
    -- What it does NOT fix: a span over a DRY ravine still falls to the
    -- riverbed, because the ground clamp is unconditional. Nor does terrain
    -- shaping fix it — see the deck-gap header above: the clamp raises the span
    -- with the ground, so an earthwork moves the deck and the road surface by
    -- the same amount and the gap never closes. Recorded in
    -- .tasks/notes/model-integration.md; not worked around here.
    t.floating       = true
    t.smokeTime      = 0
    t.metal          = 0
    t.energy         = 0
    t.customparams   = t.customparams or {}
    t.customparams.ms_feature_kind = 'bridge'
    t.customparams.chain_axis  = 'z'   -- tiles along local Z (RH, -Z forward)
    t.customparams.chain_pitch = '24'  -- metres between segment centres; measured, exact
    t.customparams.cosmetic_span = '1' -- non-blocking pending the deck-pathing engine ask
    t.customparams.generator = 'Claude Fable 5 (tools/forge)'
    return t
end

return {
    -- 8.9 m wide, 4.5 m tall, 24.0 m per segment. Riveted steel through-truss
    -- with a cracked concrete deck and pier footings. The road crossing:
    -- scorched_crossing is the natural first map for it (§M4).
    ms_road_bridge = span{
        description = 'Road bridge span — riveted through-truss, 24 m segment',
        object      = 'ms_road_bridge',
        footprintx  = 4, footprintz = 12,     -- 8 x 24 m
        health      = 6000,                   -- inert while indestructible; sized for the flip
        mass        = 9000,
        customparams = {
            -- Roadway slab surface above the model's y = 0, measured off the
            -- shipped mesh (28 verts at y = 1.500 spanning x -4.35..+4.35,
            -- kerb tops at 1.72 outboard of it). See the deck-gap header.
            deck_top = '1.5',
        },
    },

    -- 4.4 m wide, 4.2 m tall, 24.0 m per segment (rail heads to 24.08). Deck
    -- truss carrying track on top, pier footings below. Pairs with fable_train
    -- routes and with ms_train_wreck when the line is meant to read as cut.
    ms_rail_bridge = span{
        description = 'Rail bridge span — deck truss, track on top, 24 m segment',
        object      = 'ms_rail_bridge',
        footprintx  = 2, footprintz = 12,     -- 4 x 24 m
        health      = 5000,
        mass        = 7000,
        customparams = {
            -- Deck slab top, NOT the rail head (4.15): the deck is what a
            -- vehicle would stand on and what an abutment has to meet.
            deck_top = '3.8',
        },
    },
}
