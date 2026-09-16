-- authority/field_engineering.lua — the "field engineering only" gate, as a
-- pure decision (manual §1/§6, ruling 2026-08-19; review 2026-09-10 closes
-- manual §12's "convention, not a code gate").
--
-- Battles have NO production economy: force enters a battle only as transport
-- arrivals, and the only in-battle construction is the support tier —
-- trenches, barricades, watchtowers, a command post, a supply dump. The four
-- factories still DECLARE full buildoptions (the defs are shared with the
-- world layer, where production lives), so until now the invariant rested on
-- scenarios not handing a player a factory. This module is the gate; the
-- callins that consult it live in game_authority.lua (layer -100, so a vetoed
-- build order is refused before game_authority_charge.lua at +100 can bill
-- it — the same ordering proof that gadget's header carries).
--
-- WHAT DECIDES. `LuaRules/Configs/field_engineering.lua` names the tier by
-- the def tag the buildings already carry — `customparams.building_family`
-- ('support' is the staging-post kit, buildings_support.lua) — plus explicit
-- per-def allow/deny lists for the exceptions a scenario author needs. No
-- unit def had to change: the tag was already the authored answer to "which
-- family is this", it just had no reader.
--
-- Pure: no Spring/GG. `def` is a plain table `{ name, isBuilding,
-- customParams }` the caller lifts off UnitDefs, so this is busted-testable
-- against fabricated violating input (authority/tests/field_engineering_spec.lua).

local M = {}

--- Reasons, so a log line and a test can say WHY rather than just "no".
M.ALLOW_ESCAPE     = 'battle_production'   -- the modoption escape hatch is on
M.ALLOW_DEF        = 'allowed_def'         -- named in the config's allow list
M.ALLOW_FAMILY     = 'field_engineering'   -- a building of an allowed family
M.DENY_DEF         = 'denied_def'          -- named in the config's deny list
M.DENY_STRUCTURE   = 'base_structure'      -- a building outside the field tier
M.DENY_PRODUCTION  = 'production'          -- a mobile unit: factory output
M.DENY_UNKNOWN     = 'unknown_def'         -- no def to classify: fail closed

--- Decide whether `def` may be CREATED in battle (by a factory or a builder).
--- @param spec    the Config table (allowed_families / allowed_defs / denied_defs)
--- @param def     `{ name, isBuilding, customParams }` or nil
--- @param escape  true when the `battle_production` modoption is on
--- @return allow (bool), reason (one of the M.* strings above)
function M.verdict(spec, def, escape)
    if escape then return true, M.ALLOW_ESCAPE end
    if not def or not def.name then return false, M.DENY_UNKNOWN end
    spec = spec or {}
    local name = def.name
    if spec.denied_defs and spec.denied_defs[name] then return false, M.DENY_DEF end
    if spec.allowed_defs and spec.allowed_defs[name] then return true, M.ALLOW_DEF end
    if def.isBuilding then
        local family = def.customParams and def.customParams.building_family
        if family and spec.allowed_families and spec.allowed_families[family] then
            return true, M.ALLOW_FAMILY
        end
        return false, M.DENY_STRUCTURE
    end
    return false, M.DENY_PRODUCTION
end

--- Coerce a modoption value the way Spring hands them over: booleans arrive
--- as the strings '0'/'1' (or 'true'/'false' from a hand-written manifest),
--- occasionally as real booleans/numbers from a Lua caller. Anything else is
--- off — the escape hatch must never be on by accident.
function M.escapeFromModOption(v)
    if v == true or v == 1 then return true end
    if type(v) == 'string' then
        v = v:lower()
        return v == '1' or v == 'true'
    end
    return false
end

return M
