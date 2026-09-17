-- scenarios/tutorial_01.lua — Basic Training: the first solo Mission.
--
-- A tutorial IS a scenario. game_scenario.lua stages the roster and the
-- terminal objective; game_tutorial.lua (the Tutorial Director) walks the
-- `beats` table below and publishes one card at a time as `tutorial_*`
-- rulesParams for ui/widgets/tutorial-guide.js. Nothing here touches world
-- ownership (`solo = true`, `ephemeral = true`); the session still counts
-- toward Standing at mission end.
--
-- Map + coordinates: the compact landing at Amber Row, copied from
-- crossing_standoff.lua (mask-verified for INFANTRY/VEH/HEAVY). The arc runs
-- amber_row -> grey_flat (east) -> storm_sound (north), both direct
-- neighbours of the landing on the 4x4 region graph.
--
-- FILE-SCOPE NOTE: a PURE table literal — the lobby parses it in a bare
-- lua_State and a computed value makes the whole scenario vanish.

return {
    version   = 1,
    name      = 'Basic Training',
    tutorial  = true,            -- activates game_tutorial.lua
    solo      = true,            -- a solo Mission: own roster, no faction stake
    ephemeral = true,            -- never hibernates

    briefing = {
        title    = 'Basic Training',
        subtitle = 'Command School — First Session',
        story    = [[Welcome to command school, Recruit. Before your Faction trusts you with a Mission that matters, you will learn to move a small column across open country and hold what you take.

This exercise runs on the Scorched Crossing proving grounds. A Union sparring detachment is posted on the far side of the map. No contact is scheduled. That has been said before.]],
        tips     = {
            'Left-click selects a squad; right-click open ground orders it to move. Every order costs authority, so give few, clear orders.',
            'Click a selected squad\'s chip to drill in: what it is, where it is, what it can do.',
            'Objectives pay authority when you complete them. The board is behind the Battle menu (Tab).',
            'The coach card on the left tells you what to do next. Show me points the camera; Skip moves on.',
        },
    },

    world = {
        map     = 'scorched_crossing_v2.4',
        regions = {
            { key = 'amber_row', team = 0 },
        },
    },

    -- The learning side first (the host seat), the sparring side second.
    -- `?play=` seats the default play AI on every non-host playable side.
    sides = {
        { faction = 'compact', team = 0 },
        { faction = 'union',   team = 1 },
    },

    units = {
        -- ===== COMPACT (team 0) — the Recruit's capped roster at Amber Row
        { def = 'ms_soldiers_s1', team = 0, x = 766,  z = 6497, facing = 'north', count = 2, spacing = 110 },
        { def = 'ms_tanks_s2',    team = 0, x = 1156, z = 6272, facing = 'north' },
        { def = 'ms_engineers_s1', team = 0, x = 765, z = 6046, facing = 'north' },

        -- ===== UNION (team 1) — the sparring detachment at Iron Bend, one
        -- diagonal away. Small on purpose: it exists so the map has another
        -- side, not so the Recruit fights it.
        { def = 'ms_soldiers_s1', team = 1, x = 6142, z = 1121, facing = 'south', count = 2, spacing = 110 },
        { def = 'ms_radar_s1',    team = 1, x = 6402, z = 670,  facing = 'south' },
    },

    -- ========================================================================
    -- BEATS — the coach's script (schema: game_tutorial.lua header).
    -- Client checks (selection / drilldown / menu) are verified by the widget
    -- and acked; sim checks (presence / objective / region) are polled here.
    -- ========================================================================
    beats = {
        { id    = 'welcome',
          title = 'Welcome to command school',
          text  = 'Your column is parked at Amber Row, bottom-left of the map. This session teaches three things: select, move, hold. Press Next when you are ready.',
          show  = { region = 'amber_row' },
          wait  = { kind = 'ack' } },

        { id    = 'select',
          title = 'Select a squad',
          text  = 'Left-click one of your squads at Amber Row. Drag a box to take several at once.',
          show  = { region = 'amber_row' },
          wait  = { kind = 'client', check = 'selection' },
          timeoutFrames = 2700 },

        { id    = 'drilldown',
          title = 'Drill in',
          text  = 'Click the selected squad\'s chip in the focus strip. Every summary in this HUD opens into detail and actions the same way.',
          wait  = { kind = 'client', check = 'drilldown' },
          timeoutFrames = 2700 },

        { id    = 'move_grey_flat',
          title = 'Move to Grey Flat',
          text  = 'Right-click open ground inside Grey Flat, the region east of your landing. One order is enough: a squad keeps going until it arrives.',
          show  = { region = 'grey_flat' },
          wait  = { kind = 'presence', region = 'grey_flat', min = 1 },
          timeoutFrames = 5400 },

        { id    = 'hold_grey_flat',
          title = 'Hold Grey Flat',
          text  = 'Keep at least one squad in Grey Flat for thirty seconds. Objectives like this one pay authority when they complete.',
          show  = { region = 'grey_flat' },
          objective = { type = 'control', scope = 'tactical', region = 'grey_flat',
                        holdFrames = 900, reward = 40 },
          wait  = { kind = 'objective' },
          timeoutFrames = 5400 },

        { id    = 'battle_menu',
          title = 'Open the Battle menu',
          text  = 'Press Tab, or click Battle at the top right. Objectives, events, reports and diplomacy all live behind that one button.',
          show  = { panel = 'objectives' },
          wait  = { kind = 'client', check = 'menu' },
          timeoutFrames = 2700 },

        { id    = 'move_storm_sound',
          title = 'Move to Storm Sound',
          text  = 'Now take a squad north to Storm Sound, the region above your landing. Close the menu first if it is in the way (Esc).',
          show  = { region = 'storm_sound' },
          wait  = { kind = 'presence', region = 'storm_sound', min = 1 },
          timeoutFrames = 5400 },

        { id    = 'hold_storm_sound',
          title = 'Hold Storm Sound',
          text  = 'Hold Storm Sound for forty-five seconds to finish the Mission. That is the whole game in one line: take ground, keep it, get paid.',
          show  = { region = 'storm_sound' },
          wait  = { kind = 'region', region = 'storm_sound' },
          timeoutFrames = 5400 },
    },

    objectives = {
        -- The terminal objective: hold Storm Sound. Scoped to the learning
        -- team (a solo Mission has exactly one human side).
        { type = 'control', scope = 'strategic', forTeam = 0,
          region = 'storm_sound', reward = 100,
          victory = true, holdFrames = 1350 },
    },

    orders = {},
}
