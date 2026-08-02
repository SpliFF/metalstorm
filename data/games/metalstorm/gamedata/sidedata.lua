-- gamedata/sidedata.lua — faction declarations (Spring convention).
--
-- RESOLVES AN UNOWNED GAP: PLAN-metalstorm-lobby.md §1b/§7.1 requires
-- "available factions declared in game data" (faction is a permanent
-- account-level allegiance — PLAN-metalstorm.md §2; wars seed sides from
-- factions — PLAN-metalstorm-wars.md). The Spring-native home for side/
-- faction declarations is gamedata/sidedata.lua (both BAR and ZK ship one)
-- — decision recorded in PLAN-metalstorm-structure.md D2.
--
-- Enabled 2026-08-02 for PLAN-metalstorm-lobby.md task 0 (faction
-- registration): the lobby needs real faction rows — with lore text — to
-- populate the sign-up form. Factions are still NOT mechanically
-- differentiated in sim (no per-faction unit rosters, no faction-gated
-- gadgets) — same status as scenario_smoke_test.lua / meridian_basin.lua's
-- `sides` blocks, which already reference these two keys. This file only
-- makes the *names* real; mechanical differentiation is unstarted, separate
-- work.
--
-- FIELD NOTE on `name` vs `fullName`: the engine's SideParser
-- (rts/Sim/Misc/SideParser.cpp) reads `name` + `startUnit` and derives its
-- side key by lowercasing `name` verbatim — it does not know about a
-- separate `key` field. To keep the lobby's faction key
-- (`accounts.faction_id`) in parity with that derivation (the stub's own
-- warning it replaces, §7.1), `name` here is kept a short one-word
-- key-able token ('Compact' / 'Union') matching the faction keys the
-- scenario files already use lowercase ('compact' / 'union') — the
-- evocative identity name for the sign-up screen lives in `fullName`,
-- which SideParser ignores. `description` is the lore/identity blurb the
-- sign-up form shows; also ignored by SideParser, read only by the
-- lobby's faction-list route (rts/Server/FactionData.h).
return {
    {
        name        = 'Compact',
        fullName    = 'The Meridian Compact',
        description = 'Engineers and orbital surveyors who mapped the rift before anyone else '
            .. 'thought to claim it. The Compact plays a long, methodical game: every region it '
            .. 'takes gets a fabricator plant before a gun turret. It wins wars of attrition by '
            .. 'simply out-building everyone else.',
        startUnit   = 'ms_engineers_s1',
    },
    {
        name        = 'Union',
        fullName    = 'The Foundry Union',
        description = 'A federation of foundry crews and shipyard guilds who broke from the '
            .. 'Compact charter when it started rationing furnace time. The Union trusts hands '
            .. 'on the line over ledgers in an office, and fights to keep every foundry it has '
            .. 'ever lit running — for itself, not for a survey map.',
        startUnit   = 'ms_engineers_s1',
    },
}
