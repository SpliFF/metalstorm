-- scenarios/crossing_standoff.lua — the showcase war.
--
-- Replaces scenarios/meridian_basin.lua, which was retired 2026-08-06.
-- The decision and its costs are PLAN-metalstorm-wars.md §7.6; the short
-- version is that Meridian Basin is not a playable map. Its eight start
-- positions sit in THREE disconnected components of the VEH/HEAVY
-- passability mask and its own basin victory objective is reachable by
-- neither side's armour, so no pacing change could ever have made the two
-- armies meet. `tools/mapgen/regions_from_map.py data/maps/meridian_basin
-- --verify` exits 2 and says so. Scorched Crossing exits 0 for INFANTRY,
-- VEH and HEAVY alike.
--
-- WHY THIS MAP, since the gate alone did not decide it. scorched_crossing_v2.4
-- is a 4x4 graph of 1792-elmo regions with a single dead-centre region,
-- `raven_basin` (4480, 4480), that is 4007 elmos from EACH of the two
-- diagonally-opposite home regions this war lands on (`amber_row` SW,
-- `iron_bend` NE). A symmetric approach to a reachable prize is what
-- PLAN-metalstorm-wars.md §7.5's "a war is won by holding the prize against
-- someone" actually requires, and it is the property Meridian never had.
--
-- REGION ADDRESSING. This map ships mapdata/regions.lua, so game_regions.lua
-- selects the named GRAPH provider, not the 2048-elmo grid. Every key below
-- is copied from that file. They are GENERATED names, not Meridian's
-- hand-authored ones — there is no key in common between the two maps, which
-- is most of why §7.6 rejected "port the old scenario" as a rename.
--
-- NOTHING THAT SHOOTS IS ON A TEAM THE LOBBY CANNOT SEAT. This is the content
-- rule §7.6 adds, and it is the reason the neutral settlements below are
-- habitats, depots, transit hubs and civilians with no `ms_staticdefense_*`
-- and no `ms_militia`, and the reason this file declares no NPC faction at
-- all. A scenario's "hostile NPC" team index collides with Gaia — the engine
-- puts Gaia at maxTeamId+1 derived from the ROOM ROSTER, not from the
-- scenario's `sides` — and Gaia is its own ally team with no allies, which is
-- this engine's definition of hostile, not of neutral. Measured consequence
-- (PLAN-metalstorm-scenariogen.md §12.3/§12.4): a Gaia-owned howitzer
-- destroyed one side's entire infantry component 2740 elmos short of the
-- objective, and the two player armies never met each other in either
-- verified run. A showcase war whose whole job is two armies fighting cannot
-- have its outcome decided by set dressing the lobby offers no way to seat.
-- Set dressing that cannot shoot cannot decide a war.
--
-- FILE-SCOPE NOTE (see the same note in game_scenario.lua): this must stay a
-- PURE Lua table literal. ScenarioDiscovery::LoadOne parses it with a bare
-- lua_State — no VFS, no Spring.*, no require — and a computed global at file
-- scope does not fail loudly, it makes the scenario silently vanish from the
-- lobby's Create Game list.
--
-- Every coordinate below is on the map's real passability mask, in the same
-- connected component as both landing zones, for every movement class the
-- roster stages. The landing-zone and settlement sites are taken from
-- scenariogen's own mask-verified placements for this map rather than
-- eyeballed off the region rectangles.

return {
    version   = 1,
    name      = 'Scorched Crossing — The Standoff',
    tutorial  = false,
    ephemeral = false,           -- the standing showcase war (hibernates when empty)

    world = {
        map     = 'scorched_crossing_v2.4',
        -- Each side opens owning only its own landing zone. Everything else,
        -- the prize included, starts uncontrolled — the whole map between the
        -- two armies is neutral ground they have to walk into.
        regions = {
            { key = 'amber_row', team = 0 },   -- SW home, compact landing
            { key = 'iron_bend', team = 1 },   -- NE home, union landing
        },
    },

    -- Two sides, two teams, numbered consecutively from 0 so the engine
    -- materialises no unoccupied gap teams between them (an unoccupied live
    -- team is endtoend D19's shape). Both are staged an army in `units`,
    -- which is what makes ScenarioDiscovery resolve them with staged == true
    -- and what makes the room's `war_sides` modoption read `compact:0,union:1`.
    --
    -- BOTH SIDES ARE EXPEDITIONARY (PLAN-metalstorm-transports.md §7.1), and
    -- this file's own briefing is why: "Compact landing barges ground ashore
    -- at Amber Row while Union drop-lifters flared down over Iron Bend". Two
    -- armies were SENT here; neither is standing in its own town. That flag is
    -- not decoration — it gates `ms_stranded_<team>` and the
    -- `war_side_stranded` guard, which exist only for a force that arrived by
    -- transport and can therefore be trapped. A home defender must NOT carry
    -- it (see meridian_basin.lua, where neither side does), or the guard fires
    -- on people standing in their own kitchen, forever.
    --
    -- `departure` is §3.4's withdrawal zone — and, under the §7.10
    -- unification, the same circle the objectives layer calls `extractArea`
    -- (objectives/escort.lua's header carries the full reasoning). Each sits
    -- BEHIND its own army, on the far side from the basin: you leave the way
    -- you came. Placed >= 900 elmos from the parked carrier below on purpose —
    -- a departure zone drawn over your own staged transport deletes it on the
    -- first poll after frame 60, which is a mechanic that reads as a crash.
    sides = {
        { faction = 'compact', team = 0, expeditionary = true,
          departure = { x = 400, z = 6900, radius = 500 } },
        { faction = 'union',   team = 1, expeditionary = true,
          departure = { x = 5776, z = 1524, radius = 500 } },
    },

    -- Briefing (S2): lobby/client DISPLAY ONLY. ScenarioDiscovery parses it
    -- for the loading splash; game_scenario.lua ignores the key entirely.
    -- Like everything else in this file it must stay inside the pure table
    -- literal — no concatenation, no function calls — or the whole scenario
    -- silently vanishes from the lobby's list (see the FILE-SCOPE NOTE above).
    -- The one easy way to break it: an apostrophe inside a single-quoted tip.
    -- Escape it (\') or use a [[long string]].
    -- Edits here are invisible until the lobby restarts or
    -- POST /api/admin/scenarios/resync runs — the lobby snapshots scenarios
    -- at startup.
    briefing = {
        title    = 'The Standoff',
        subtitle = 'Scorched Crossing',
        story    = [[The armistice died at dawn. Compact landing barges ground ashore at Amber Row while Union drop-lifters flared down over Iron Bend — two armies, diagonal across a scorched river country, each sent to take the same prize.

Between them lies Raven Basin: the dead-centre crossing every supply road on this map runs through. Whoever holds the basin holds the war. The towns of the crossing — Marrow Watch on the far diagonal, Storm Sound and Ash Verge on the flanks — declared for nobody. They will trade with whoever controls their streets, and they will remember who let their people die.

Your column is already rolling. The enemy's is too. You will meet in the middle.]],
        tips     = {
            'Both armies open with standing FIGHT orders converging on Raven Basin — the battle starts without you, but it will not be won without you.',
            'Victory is holding Raven Basin for 3 unbroken minutes (earliest decision ~2 minutes in). A contested basin resets the hold clock: winning means holding the middle against the other army, not touching it first.',
            'Three neutral settlements pay control rewards: Marrow Watch sits equally far from both armies; Storm Sound is your flank if you land in the south-west, Ash Verge if you land in the north-east.',
            'Each side has a protect objective on its own flank town\'s civilians — it expires at the 10-minute mark, and a raid on the enemy\'s town denies them the reward.',
            'Your engineers and radar mast start at home, not in the push. Put them to work: radar coverage of the basin approaches decides who sees the fight first.',
            'Artillery outranges tanks. Keep the ms_artillery_s2 batteries behind your tank line and the basin approaches become killing ground.',
        },
        -- image: none yet — the splash falls back to /api/maps/thumb/
        -- (scorched_crossing_v2.4's processed thumbnail). Add
        -- scenarios/img/crossing_standoff.jpg (3:1 banner) when art exists.
        parTimeSec = 900,
    },

    -- No `ai` block, deliberately — see the team-seating note at the top of
    -- this file. An NPC faction here would land on the Gaia team index and
    -- turn the neutral settlements into a third hostile army the lobby has
    -- no slot for.

    units = {
        -- ================= COMPACT (team 0) — landing zone `amber_row` =====
        -- The opening FIGHT for every mobile entry is the SAME point for both
        -- sides: (4480, 4480), the centroid of the `raven_basin` polygon.
        -- Not each side's near edge of it — two armies ordered to their own
        -- edge "arrive" in the same region and out of weapon range of each
        -- other, which is how a war can be decided with no shot fired
        -- (endtoend D20's fire-7 finding). Engineers and the sensor mast stay
        -- home on purpose; they are not part of the push.
        { def = 'ms_tanks_s2', team = 0, x = 1156, z = 6272, facing = 'north', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_tanks_s3', team = 0, x = 1091, z = 6609, facing = 'north', count = 2, spacing = 180,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_soldiers_s1', team = 0, x = 766, z = 6497, facing = 'north', count = 6, spacing = 100,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_artillery_s2', team = 0, x = 636, z = 6272, facing = 'north', count = 2, spacing = 160,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_engineers_s1', team = 0, x = 765, z = 6046, facing = 'north', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 0, x = 1026, z = 6046, facing = 'north' },
        -- The lift that brought this army here, parked where it set down
        -- (§3.2: staged-as-arrived, NOT a frame-0 drive-in — serially
        -- unloading an army at the top of the match buys theatre and costs the
        -- opening pacing D20 spent seven fires fixing). No order: a carrier
        -- that flies off on its own is a carrier the player cannot use, and
        -- withdrawal is a mechanic, not a menu (§3.4) — load it, protect it,
        -- fly it to the departure zone yourself.
        { def = 'fable_airship', team = 0, x = 1300, z = 6600, facing = 'north' },

        -- ================= UNION (team 1) — landing zone `iron_bend` =======
        { def = 'ms_tanks_s2', team = 1, x = 6532, z = 896, facing = 'south', count = 4, spacing = 150,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_tanks_s3', team = 1, x = 6467, z = 1233, facing = 'south', count = 2, spacing = 180,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_soldiers_s1', team = 1, x = 6142, z = 1121, facing = 'south', count = 6, spacing = 100,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_artillery_s2', team = 1, x = 6012, z = 896, facing = 'south', count = 2, spacing = 160,
          orders = { { cmd = 'FIGHT', params = { 4480, 0, 4480 } } } },
        { def = 'ms_engineers_s1', team = 1, x = 6142, z = 670, facing = 'south', count = 2, spacing = 120 },
        { def = 'ms_radar_s1', team = 1, x = 6402, z = 670, facing = 'south' },
        -- The union lift, mirrored on the same (+5376, -5376) diagonal offset
        -- every other entry on this side uses.
        { def = 'fable_airship', team = 1, x = 6676, z = 1224, facing = 'south' },

        -- ================= NEUTRAL SETTLEMENTS (Gaia) =====================
        -- `team = 'neutral'` resolves to the Gaia team at stage time: the
        -- Gaia id is playerTeamCount, which depends on the room roster and is
        -- therefore NOT knowable when this file is written.
        --
        -- Buildings are staged through `units`, not through the `civilians`
        -- block, because that block registers everything role='ambient' and
        -- civilians/routines.lua then issues CMD_MOVE at every ambient entry
        -- every tick — enrolling immobile buildings in a move loop they can
        -- never satisfy.
        --
        -- WHERE they are is as deliberate as what they are. All three sites
        -- sit OFF the two approach corridors (amber_row -> grey_flat ->
        -- raven_basin, and iron_bend -> ash_verge -> raven_basin) so that a
        -- FIGHT-ordered army does not divert into a village instead of
        -- meeting the enemy. Marrow Watch is equidistant from both landings
        -- (4007 elmos, same as the prize); Storm Sound and Ash Verge are exact
        -- mirrors of each other, one on each side's flank.

        -- Marrow Watch (region `marrow_watch`) — the neutral town on the
        -- cross-diagonal, equally far from both armies.
        { def = 'ms_habitat',     team = 'neutral', x = 2591, z = 2759, facing = 'south' },
        { def = 'ms_habitat',     team = 'neutral', x = 2860, z = 2521, facing = 'south' },
        { def = 'ms_depot',       team = 'neutral', x = 2343, z = 2585, facing = 'south' },
        { def = 'ms_transit_hub', team = 'neutral', x = 2643, z = 2210, facing = 'south' },
        { def = 'ms_civilians',   team = 'neutral', x = 2423, z = 2819, facing = 'south' },
        { def = 'ms_civilians',   team = 'neutral', x = 2790, z = 2330, facing = 'south' },

        -- Storm Sound (region `storm_sound`) — the compact side's flank.
        { def = 'ms_habitat',     team = 'neutral', x = 896,  z = 4480, facing = 'south' },
        { def = 'ms_depot',       team = 'neutral', x = 1131, z = 4468, facing = 'south' },
        { def = 'ms_transit_hub', team = 'neutral', x = 779,  z = 4685, facing = 'south' },

        -- Ash Verge (region `ash_verge`) — the union side's flank, mirrored.
        { def = 'ms_habitat',     team = 'neutral', x = 6272, z = 2688, facing = 'south' },
        { def = 'ms_depot',       team = 'neutral', x = 6218, z = 2441, facing = 'south' },
        { def = 'ms_transit_hub', team = 'neutral', x = 6262, z = 2939, facing = 'south' },
    },

    -- The populations the two `protect` objectives below are scored on. These
    -- MUST come through the `civilians` block rather than `units`, because
    -- `_populateTargetsFrom`'s `role` filter reads GG.Civilians' registry and
    -- a role lives only there, never on a unitdef (game_scenario.lua:493-518).
    --
    -- Each is offset >= 220 elmos from its settlement's building centres:
    -- ms_habitat's 12x12 footprint blocks ground out to a 96-elmo half-extent
    -- per axis, and a unit spawned inside a structure's blocked yardmap is
    -- trapped permanently — GiveOrderToUnit "succeeds" and the unit never
    -- moves. That cost a debugging session on Meridian; it does not need to
    -- cost another one here.
    civilians = {
        units = {
            { def = 'ms_civilians', x = 993, z = 4694, facing = 'south', role = 'ambient' },  -- Storm Sound
            { def = 'ms_civilians', x = 668, z = 4542, facing = 'south', role = 'ambient' },  -- Storm Sound
            { def = 'ms_civilians', x = 6507, z = 2690, facing = 'north', role = 'ambient' }, -- Ash Verge
            { def = 'ms_civilians', x = 6038, z = 2721, facing = 'north', role = 'ambient' }, -- Ash Verge
        },
    },

    -- ========================================================================
    -- REINFORCEMENT ARRIVALS (PLAN-metalstorm-transports.md §3.3, staged by
    -- game_transports.lua).
    -- ========================================================================
    -- Since the 2026-08-19 field-engineering ruling removed production from
    -- battle maps, an arrival is the ONLY way force enters a battle after the
    -- opening. There is deliberately no in-battle way to ASK for one (§7.2):
    -- the schedule is fixed when the scenario materialises at staging end,
    -- because a request verb is production wearing a hat and would make a
    -- battle's outcome a function of world wallet size rather than of what you
    -- chose to bring.
    --
    -- WHERE `eta` COMES FROM (§7.8's projection rule, §7.4's clock). The world
    -- layer resolves a committed force's transit and hands the battle a single
    -- number: forces landing before battle start are staged on field (the
    -- carriers above); forces landing after it become entries here, with
    -- `eta = worldETA - battleStart` at the world clock's 24x ratio — one world
    -- hour is ~4500 frames. 4500 is therefore "these two squads were one world
    -- hour behind the main body when the shooting started". It lands after the
    -- victory objective's `notBefore = 3600`, so a wave can never arrive into a
    -- war that has already been decided (an eta past the ending is cancelled,
    -- not spawned).
    --
    -- Mirrored, because this file's whole argument is symmetry: same eta, same
    -- cargo, same slot cost. Each wave enters over its own side's BACK edge —
    -- west for the south-west landing, north for the north-east one — and sets
    -- down on its own landing zone rather than in the middle, so the wave is a
    -- reinforcement to a fight and not a flank nobody could see coming.
    --
    -- `order` is not optional in spirit even though the schema allows nil
    -- (D20 finding 1: a unit nobody ordered never moves, and a wave that
    -- unloads into silence is a wave that never fights). Both point at the
    -- same (4480, 4480) basin centroid every staged column is already
    -- converging on.
    --
    -- Capacity is real and checked at load: `fable_airship` carries 2 slots,
    -- an s1 squad costs 1 slot (§7.7 counts slots in scale tiers, so an s3
    -- formation would cost 3 and not fit). Two s1 squads is exactly full.
    arrivals = {
        { id       = 'compact_wave_1',
          team     = 0,
          kind     = 'air',
          def      = 'fable_airship',
          eta      = 4500,
          -- The west edge, well clear of this side's own departure zone at
          -- (400, 6900): a wave that enters INSIDE its own exit is a wave that
          -- can withdraw itself the moment it stops being cargo.
          entry    = { x = 150,  z = 5400 },
          dropZone = { x = 1091, z = 6609 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 4480, z = 4480 } },

        { id       = 'union_wave_1',
          team     = 1,
          kind     = 'air',
          def      = 'fable_airship',
          eta      = 4500,
          entry    = { x = 6467, z = 150 },
          dropZone = { x = 6467, z = 1233 },
          cargo    = { { def = 'ms_soldiers_s1', count = 2 } },
          order    = { cmd = 'FIGHT', x = 4480, z = 4480 } },
    },

    objectives = {
        -- ===== THE VICTORY OBJECTIVE =====================================
        -- `victory = true` is the only terminal condition game_gameover.lua
        -- watches, and ScenarioDiscovery::DefaultForMap skips a scenario
        -- without one outright. Exactly one, and it is an OPEN race
        -- (forTeam nil) so either side may take it — an objective scoped to a
        -- team the launch did not supply throws "Bad teamID" out of the
        -- Objectives gadget's callin, gadgetHandler removes the gadget, and
        -- then nothing is evaluated for the rest of the match.
        --
        -- SIZING. scenariogen measured the worst-case approach on this map at
        -- 3411 frames for the slowest staged class. `notBefore = 3600` puts
        -- the earliest possible completion after BOTH armies have arrived, so
        -- "the war ended before the sides could meet" is unrepresentable
        -- rather than merely unlikely; `holdFrames = 5400` is
        -- DEFAULT_VICTORY_HOLD_FRAMES, and a contested basin resets the hold,
        -- so winning means holding the middle against the other army rather
        -- than touching it first. Floor on the war: 9000 frames / 5 minutes.
        -- No expiry — the basin is the war's focal point, it does not lapse.
        { type = 'control', scope = 'strategic', forTeam = nil,
          region = 'raven_basin', reward = 300,
          victory = true,
          notBefore = 3600, holdFrames = 5400,
          expiresAtFrame = nil },

        -- ===== TACTICAL: the three neutral settlements ====================
        -- Open races, no expiry. Marrow Watch is the symmetric prize; the two
        -- flank towns are each side's own cheap income if they garrison them,
        -- and each other's raid target if they do not.
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'marrow_watch', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'storm_sound', reward = 110,
          expiresAtFrame = nil },
        { type = 'control', scope = 'tactical', forTeam = nil, region = 'ash_verge', reward = 110,
          expiresAtFrame = nil },

        -- ===== TACTICAL: keep your flank town alive ======================
        -- targetUnitIDs is populated at the frame-30 civilian sweep from the
        -- area below; the objective is skipped with a log line, not staged
        -- empty, if the sweep finds nothing (an empty array fails init
        -- validation).
        { type = 'protect', scope = 'tactical', forTeam = 0,
          params = { targetUnitIDs = {}, quorum = 1 },
          _populateTargetsFrom = { x = 896, z = 4480, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 18000 },

        { type = 'protect', scope = 'tactical', forTeam = 1,
          params = { targetUnitIDs = {}, quorum = 1 },
          _populateTargetsFrom = { x = 6272, z = 2688, r = 600, role = 'ambient' },
          reward = 120,
          expiresAtFrame = 18000 },
    },

    -- Top-level `orders` is warned-and-ignored by the loader; opening orders
    -- belong in the per-unit `orders` field above, and that is where they are.
    orders = {},
}
