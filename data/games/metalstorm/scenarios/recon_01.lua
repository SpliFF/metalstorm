-- scenarios/recon_01.lua — Survey: a solo Mission that is not a battle.
--
-- Proof that a Mission is a bounded task, not a fight (PLAN-beta.md
-- "Vocabulary"). Nothing staged here can shoot: the Recruit flies three scout
-- buggies and one airship, the Union side is a radar post with engineers, and
-- the terminal objective is a `parley` — the Mission ends when the two sides
-- AGREE to exchange survey intelligence. The beats walk the scouts through
-- three regions (presence checks) and then the proposal.
--
-- Same map and landing as tutorial_01 (mask-verified coordinates from
-- crossing_standoff.lua). Region graph: amber_row -> grey_flat -> kestrel_forge
-- -> raven_basin, each a direct neighbour of the last.
--
-- FILE-SCOPE NOTE: a PURE table literal (see tutorial_01.lua).

return {
    version   = 1,
    name      = 'Survey — Raven Basin',
    tutorial  = true,            -- the coach narrates it; beats below
    solo      = true,
    ephemeral = true,

    briefing = {
        title    = 'Survey',
        subtitle = 'Raven Basin — Reconnaissance',
        story    = [[The Compact wants to know what the crossing looks like before it commits an army to it. So does the Union. Neither wants to pay in blood for a map.

Take three scout cars across the river country to Raven Basin, look at what is there, then offer the Union post at Iron Bend a trade: your survey for theirs. If they agree, the Mission is done and nobody fired a shot.]],
        tips     = {
            'This Mission has no enemy. Scout cars cannot attack and neither can the Union post.',
            'Survey a region by driving a scout into it. Three regions, then the parley.',
            'The airship can carry a scout car; you will not need it here, but it is yours.',
            'A parley proposal costs a little authority. The coach card offers the proposal for you when the time comes.',
        },
    },

    world = {
        map     = 'scorched_crossing_v2.4',
        regions = {
            { key = 'amber_row', team = 0 },
            { key = 'iron_bend', team = 1 },
        },
    },

    sides = {
        { faction = 'compact', team = 0 },
        { faction = 'union',   team = 1 },   -- seated by the play AI (strategos), which answers parleys
    },

    units = {
        -- ===== COMPACT (team 0) — three scouts and the lift, at Amber Row
        { def = 'ms_scout_buggy', team = 0, x = 900,  z = 6400, facing = 'north', count = 3, spacing = 140 },
        { def = 'fable_airship',  team = 0, x = 1300, z = 6600, facing = 'north' },

        -- ===== UNION (team 1) — a listening post at Iron Bend. Unarmed.
        { def = 'ms_radar_s1',     team = 1, x = 6402, z = 670, facing = 'south' },
        { def = 'ms_engineers_s1', team = 1, x = 6142, z = 670, facing = 'south' },
    },

    beats = {
        { id    = 'welcome',
          title = 'A Mission without a battle',
          text  = 'Three scout cars, one airship, no guns. Your job is to look at three regions and then talk. Press Next.',
          show  = { region = 'amber_row' },
          wait  = { kind = 'ack' } },

        { id    = 'survey_grey_flat',
          title = 'Survey Grey Flat',
          text  = 'Select a scout and right-click inside Grey Flat, east of your landing. A scout in a region is a survey of it.',
          show  = { region = 'grey_flat' },
          wait  = { kind = 'presence', region = 'grey_flat', min = 1 },
          timeoutFrames = 5400 },

        { id    = 'survey_kestrel_forge',
          title = 'Survey Kestrel Forge',
          text  = 'Now Kestrel Forge, north of Grey Flat. Send a second scout if you like: orders cost authority, scouts do not.',
          show  = { region = 'kestrel_forge' },
          wait  = { kind = 'presence', region = 'kestrel_forge', min = 1 },
          timeoutFrames = 5400 },

        { id    = 'survey_raven_basin',
          title = 'Survey Raven Basin',
          text  = 'Raven Basin is the crossing every road on this map runs through. Put a scout in it.',
          show  = { region = 'raven_basin' },
          wait  = { kind = 'presence', region = 'raven_basin', min = 1 },
          timeoutFrames = 5400 },

        { id    = 'parley',
          title = 'Offer the Union a trade',
          text  = 'Propose an intelligence exchange to the Union post: your survey of Raven Basin for theirs. Use the button below, or the Diplomacy tab of the Battle menu.',
          show  = { panel = 'diplomacy' },
          parley = { kind = 'intel', toTeam = 1, regionKeys = { 'raven_basin' } },
          wait  = { kind = 'pact', pact = 'intel' },
          timeoutFrames = 5400 },
    },

    objectives = {
        -- The terminal objective is an AGREEMENT, not a hold: complete once an
        -- intel pact between the two sides is accepted (objectives/parley.lua).
        { type = 'parley', scope = 'strategic', forTeam = 0,
          params = { kind = 'intel', withTeam = 1 },
          reward = 100, victory = true },
    },

    orders = {},
}
