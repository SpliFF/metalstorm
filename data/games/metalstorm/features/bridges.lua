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
-- ⚠️ THE ENGINE-SIDE `deckHeight` THAT LANDED (PLAN-maps §2j option C) IS THE
-- SEATING HALF, NOT THE PATHING HALF. `FeatureDef::deckHeight` (resolved from
-- `customparams.deck_top` below) makes a span HOLD the y it was staged at
-- instead of being clamped up to the ground — a level deck. It does NOT raise
-- the blocking map's sampled Y and it does NOT make anything walk over a span.
-- The paragraphs above stand exactly as written: `blocking = false` is still
-- the right half of a binary choice, and flipping it is still gated on the
-- pathing work, which nobody has done. (For a month after §2j option A landed
-- the seating half did not fire on these two defs either, because a truthful
-- `deck_top` of 0 read as "no deck"; that was repaired on 2026-09-20 and is
-- written up in the next section. The pathing half was never contingent on
-- either.)
--
-- ============================================================================
-- THE ORIGIN IS THE DECK (PLAN-maps.md §2j option A, LANDED 2026-08-19)
-- ============================================================================
-- Every span in this file is authored with its ORIGIN AT THE TRAFFICABLE
-- DECK. Measured off the shipped glTF: `ms_road_bridge` runs
-- y = -1.50 .. +3.02 with 28 deck verts at exactly y = 0 spanning
-- x -4.35..+4.35; `ms_rail_bridge` runs y = -3.80 .. +0.35 with its deck slab
-- top at y = 0 and the rail head at +0.35. The substructure — floor beams,
-- bottom chords, pier footings — runs NEGATIVE, which is where a real
-- abutment buries it.
--
-- WHY THE ORIGIN HAD TO MOVE. `CFeature::UpdatePosition` ends every tick with
--
--   Move(UpVector * (max(CGround::GetHeightReal(x, z), pos.y) - pos.y))
--   (Feature.cpp:570)
--
-- — a feature's y is clamped UP to the ground and can never be pushed down.
-- While the origin was the PIER BASE the deck sat `deck_top` above it, so a
-- unit driving at the terrain height under a span was always exactly
-- `deck_top` (1.5 road / 3.8 rail) below the deck it should have been driving
-- on — and **raising the terrain raised the span with it**, so the gap was
-- invariant under every earthwork a map generator can do. That is why it was
-- never a map job, and why §2j's "raised causeway whose top IS the deck" is
-- withdrawn as impossible rather than merely expensive. With y = 0 at the
-- deck, a span standing on ground `g` decks at `g`, exactly where the road it
-- meets is: on dry ground the clamp now lands the deck FLUSH.
--
-- ⚠️ THIS DOES NOT FIX A SPAN OVER WATER, and §2j said so before it landed.
-- A chain staged at the waterline (y = 0, which is what scenariogen does —
-- see game_scenario.lua's stageFeatures) now decks AT the waterline rather
-- than 1.5 above it, while units wade the bed below: the gap becomes the
-- ford's depth instead of a flat 1.5. Better where the ford is shallower than
-- 1.5, worse where it is deeper. The water case belongs to C (`deckHeight`)
-- plus a scenario that stages at a chosen deck level — not to A.
--
-- The user ruled A + C on 2026-08-19; both have now landed (C first, §2p).
--
-- 🔻 `deck_top` IS NOW ZERO, AND THAT IS THE TRUTHFUL VALUE — the deck is the
-- origin, so the offset between them is nothing. It is still published, per
-- def and not in the shared `span()` posture, because it is the number that
-- says WHERE THE DECK IS relative to the model, and a consumer that stops
-- finding it cannot tell "no deck" from "deck at 0" (ms_defs.feature_deck_top
-- raises rather than defaulting, for exactly that reason).
--
-- ✅ THE ENGINE NOW AGREES — REPAIRED 2026-09-20. For a month it did not, and
-- the shape of that bug is worth keeping: `FeatureSeating::IsSeated` was
-- `deckHeight > 0.0f`, so a truthful `deck_top = 0` read as "no deck declared"
-- and NEITHER of these two defs was seated. The encoding predated A — it was
-- written when a deck could not be at the origin — and A silently cancelled C.
-- It had no live effect (scenariogen stages every chain at y = 0 with every
-- span centre over water via `chain_is_afloat_at`, and at pos.y <= 0 the engine
-- sets the INWATER bit, SolidObject.cpp:48, so `floating = true` below zeroes
-- gravity and the chain holds y = 0 regardless — exactly the 0/0/0/0 §M3
-- measured BEFORE seating existed), but it lost the case seating was built for:
-- a level deck over a DRY ravine.
--
-- The repair split the two facts apart. `FeatureSeating::DeckSpec` carries
-- `declared` and `height` separately; `ResolveDeck` derives `declared` from the
-- PRESENCE of this key, never from its value, which is the same raise-don't-
-- default contract `ms_defs.feature_deck_top` already kept on the Python side.
-- So publishing `deck_top = '0'` below is what SEATS these defs, and deleting
-- the key is what would unseat them. Measured on green_flat_x34_v3 (dry,
-- ground 40.87), three features staged at 80.87: before, ms_road_bridge fell
-- to 40.87 exactly like the deckless ms_train_wreck control; after, it holds
-- 80.87 while the control still falls. `FeatureDefs[d].hasDeck` is published
-- to Lua alongside `deckHeight` for the same reason.
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
-- The rail span's extra 41 mm per end is 16 vertices at y=-0.894, x=+-1.74..1.86
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
    -- FLOATING IS REDUNDANT FOR A SEATED DEF, AND KEPT ANYWAY. A seated
    -- feature never runs the gravity term `floating` zeroes, so with the
    -- seating repair of 2026-09-20 (see the header) every def in this file is
    -- seated and `floating` changes nothing for them. It is kept because it
    -- costs nothing, because it is the correct posture for a span regardless,
    -- and because it is the belt to seating's braces: between option A landing
    -- and the repair, `floating` was the ONLY thing holding a chain level over
    -- water, and that is not a hole worth reopening for a one-line saving.
    --
    -- Features are not fixed in the air: CFeature::UpdatePosition applies
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
    -- What floating did NOT fix: a span over a DRY ravine fell to the riverbed,
    -- because the ground clamp was unconditional. Nor does terrain shaping fix
    -- it — see the deck-gap header above: the clamp raises the span with the
    -- ground, so an earthwork moves the deck and the road surface by the same
    -- amount and the gap never closes. **`deck_top` seating fixed that** — a
    -- span with a declared deck holds its staged y on dry ground too — and
    -- §2j option A then closed the gap itself by putting y = 0 ON the deck,
    -- at the cost of the declaration the seating test recognises. What A buys
    -- unconditionally is the case seating never could: a MAP-placed span,
    -- which the featureplacer spawns at `CGround::GetHeightReal` with no y at
    -- all, now decks AT that ground instead of 1.5 above it. Laying a LEVEL
    -- deck across uneven ground is still the scenario path's alone
    -- (game_scenario.lua's stageFeatures), and still wants seating back.
    t.floating       = true
    t.smokeTime      = 0
    t.metal          = 0
    t.energy         = 0
    t.customparams   = t.customparams or {}
    -- Defaults, not overrides: the ancient span below publishes its own kind
    -- and its own (36 m) pitch, and a posture helper must not silently undo a
    -- def's measured number.
    t.customparams.ms_feature_kind = t.customparams.ms_feature_kind or 'bridge'
    t.customparams.chain_axis  = 'z'   -- tiles along local Z (RH, -Z forward)
    t.customparams.chain_pitch = t.customparams.chain_pitch or '24'  -- metres between segment centres; measured, exact
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
            -- Roadway slab surface above the model's y = 0 — ZERO, because
            -- §2j option A made the roadway slab BE y = 0. Measured off the
            -- shipped mesh: 28 verts at y = 0.000 spanning x -4.35..+4.35,
            -- kerb tops 0.22 above it, model floor at -1.50 (was 1.500 above
            -- a pier-base origin running 0.00..4.52). Read by the ENGINE
            -- (FeatureDef::deck) as well as by content: PRESENCE of this key
            -- is what seats the def, and zero is simply the offset. See the
            -- header — that has only been true since 2026-09-20.
            deck_top = '0',
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
            -- Deck slab top, NOT the rail head (now +0.35): the deck is what
            -- a vehicle would stand on and what an abutment has to meet, and
            -- it is the surface §2j option A put at y = 0. Model floor at
            -- -3.80 (was 3.80 above a pier-base origin running 0.00..4.15).
            -- Presence seats it; the 0 is just the offset. See the header.
            deck_top = '0',
        },
    },

    -- ------------------------------------------------------------------
    -- Batch-04 ancient span (units-assets review finding 9, 2026-09-17)
    -- ------------------------------------------------------------------
    -- 12.9 m wide, 13.4 m tall, 36.0 m per segment. One impossible shallow
    -- monolithic arc with no mid-span supports, a seamless deck carrying an
    -- active cyan guide-channel, a perfect floating alloy ring threaded
    -- around mid-span, half-plinth footings at both tile ends so segments
    -- chain. The ancient counterpart of the two steel spans above, and the
    -- same posture: cosmetic, non-blocking, unselectable, permanent, floating.
    --
    -- ⚠️ THE ORIGIN IS THE FOOTINGS, NOT THE DECK. This model predates §2j
    -- option A and was never re-authored: measured off the shipped glTF the
    -- footings sit at y = 0 and the trafficable deck is a 136-vertex plateau
    -- at y = +7.0 m (56 elmos) across the mid-span. So unlike the two spans
    -- above, its `deck_top` is POSITIVE. That difference used to decide
    -- whether the engine seated a def at all; since the 2026-09-20 repair it
    -- decides only WHERE the deck is, and this span is seated for the same
    -- reason the two above are — it publishes the key. (It was, in fact, the
    -- only span still seated during the month the sign test was live.) Over
    -- water that changes nothing (`floating` already holds it). On dry ground
    -- it is the case seating was built for: stage it at grade and the deck
    -- reads 7 m above the valley floor, footings on the ground. Value is in
    -- engine world units (elmos), which is what FeatureSeating::
    -- ResolveDeckHeight consumes.
    --
    -- NOT placed automatically. BRIDGE_SPANS names it under "ancient" the way
    -- the rail span is named under "rail": available to hand-authored
    -- scenarios, not chosen by scenariogen's crossing placer, which lays road.
    ms_anc_bridge_span = span{
        description = 'Ancient bridge span — self-supporting monolithic arc, 36 m segment',
        object      = 'ms_anc_bridge_span',
        footprintx  = 6, footprintz = 18,     -- 12 x 36 m
        health      = 30000,
        mass        = 40000,
        customparams = {
            ms_feature_kind = 'ancient',      -- overrides span()'s 'bridge': it is both, and the relic reading wins for consumers that filter on kind
            relic_kind  = 'span',
            chain_pitch = '36',   -- metres between segment centres; measured, exact (overrides span()'s 24)
            deck_top    = '56',   -- elmos: the deck plateau at +7.0 m over a footings origin (seated, like every def that publishes the key)
        },
    },
}
