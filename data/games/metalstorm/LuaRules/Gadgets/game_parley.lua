-- game_parley.lua — synced parley / proposal / pact objects (PLAN-metalstorm-interaction.md §1–5). STUB.
--
-- Human↔AI (and human↔human) diplomacy as SYNCED game objects: proposals
-- (ceasefire, tribute, demands/threats, safe passage), pacts with
-- enforcement hooks, and the trust ledger (trust_<a>_<b> rulesParams).
-- Applies to allies, enemies, and the civilian estate
-- (LuaRules/Gadgets/civilians/estate.lua responds as toTeam='civ').
--
-- LOAD ORDER CONTRACT: layer -45 — after the backbone registries
-- (authority/objectives/regions) and before game_civilians (-40) so the
-- estate responder can register against an existing parley board.
--
-- Cross-plan contracts:
--   * PLAN-metalstorm-ai.md       — Actuators.respondProposal / Actuators.propose
--                                   are the AI's verbs against this board;
--                                   picture.lua reads board + trust
--   * PLAN-metalstorm-authority.md— proposal fees / tribute move through
--                                   GG.Authority (econ ledger class proposal_fee)
--   * PLAN-metalstorm-wire.md     — parley cards ride rulesParams + chat
--   * Engine ask I1 (sendGameMessage for the AI VM) tracked in interaction §7

function gadget:GetInfo()
    return {
        name    = "Parley",
        desc    = "Synced proposals, pacts + enforcement, trust ledger",
        author  = "metalstorm",
        date    = "2026",
        license = "GPL v2",
        layer   = -45,             -- backbone first; before civilians (-40)
        enabled = false,           -- STUB — flip when PLAN-metalstorm-interaction §1–5 lands
    }
end

if not gadgetHandler:IsSyncedCode() then
    return false
end

-- Public surface (proposed):
--   GG.Parley.Propose(fromTeam, toTeam, kind, terms) -> proposalId
--   GG.Parley.Respond(proposalId, accept)
--   GG.Parley.Trust(a, b) -> number
-- rulesParams: parley_<id>_* (kind, from, to, state, terms…), trust_<a>_<b>

return false
