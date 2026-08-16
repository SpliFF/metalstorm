#include "WarSideMaintenance.h"

#include <algorithm>
#include <sqlite3.h>
#include <unordered_map>

#include "WarDirector.h"
#include "WarSeeding.h"
#include "WarSlotReservation.h"

WarSideMaintenancePlan PlanWarSideMaintenance(
    const std::vector<WarSideFacts>& sides, const WarSizingLimits& limits) {
    WarSideMaintenancePlan plan;

    // ── Raises ─────────────────────────────────────────────────────────────
    const unsigned ceiling = limits.TotalCeiling();
    if (ceiling > 0) {
        unsigned total = 0;
        for (const auto& s : sides)
            total += s.slotCap;

        // Most-pressed first; ties by faction name so a war maintains the same
        // way every pass and a test can state the answer.
        std::vector<const WarSideFacts*> pressed;
        for (const auto& s : sides)
            if (s.IsPressed() && s.slotCap < WAR_SEED_MAX_CAPACITY)
                pressed.push_back(&s);
        std::sort(pressed.begin(), pressed.end(),
                  [](const WarSideFacts* a, const WarSideFacts* b) {
                      const unsigned pa = a->Used() - a->slotCap;
                      const unsigned pb = b->Used() - b->slotCap;
                      if (pa != pb) return pa > pb;
                      return a->factionId < b->factionId;
                  });

        for (const auto* s : pressed) {
            if (total >= ceiling)
                break;  // no headroom: the running server has no free slot
            plan.capRaises.push_back({s->factionId, s->slotCap, s->slotCap + 1});
            ++total;
        }
    }

    // ── Flags ──────────────────────────────────────────────────────────────
    unsigned leader = 0;
    for (const auto& s : sides)
        leader = std::max(leader, s.bound);
    for (const auto& s : sides) {
        const bool want = leader >= s.bound + WAR_UNDERDOG_DEFICIT;
        if (want != s.incentivised)
            plan.incentiveChanges.push_back({s.factionId, want});
    }

    return plan;
}

WarMaintenanceResult MaintainWarSides(sqlite3* db, uint32_t roomId,
                                      WarSizingLimits limits, int64_t now) {
    WarMaintenanceResult out;
    if (!db)
        return out;

    const auto war = WarDirector::Load(db, roomId);
    if (!war)
        return out;
    // A war that has stopped taking joiners is not resized: raising a cap on a
    // `winding_down` war advertises a seat in a war that is ending, and the
    // incentive would pay a bonus grant for walking into one.
    if (war->state == WarState::WindingDown ||
        war->state == WarState::Resolving || war->state == WarState::Archived)
        return {true, 0, 0};

    if (limits.spawnedSlotCap == 0)
        limits.spawnedSlotCap = war->spawnedSlotCap;

    const auto sideRows = WarDirector::SidesFor(db, roomId);
    if (sideRows.empty())
        return {true, 0, 0};

    // Bound population per faction, in one pass over the bindings — the same
    // durable count Deploy and the browser use, so all three agree about which
    // side is outnumbered.
    std::unordered_map<std::string, unsigned> bound;
    {
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db,
                "SELECT faction_id, COUNT(*) FROM war_player_bindings "
                "WHERE room_id=? GROUP BY faction_id",
                -1, &stmt, nullptr) == SQLITE_OK) {
            sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(roomId));
            while (sqlite3_step(stmt) == SQLITE_ROW) {
                const unsigned char* f = sqlite3_column_text(stmt, 0);
                if (f == nullptr)
                    continue;
                bound[reinterpret_cast<const char*>(f)] =
                    static_cast<unsigned>(sqlite3_column_int64(stmt, 1));
            }
        }
        sqlite3_finalize(stmt);
    }

    std::vector<WarSideFacts> facts;
    facts.reserve(sideRows.size());
    for (const auto& s : sideRows) {
        WarSideFacts f;
        f.factionId    = s.factionId;
        f.slotCap      = s.slotCap;
        f.incentivised = s.incentivised;
        const auto it = bound.find(s.factionId);
        f.bound        = it == bound.end() ? 0u : it->second;
        f.reserved =
            WarSlotReservations::LiveCount(db, roomId, s.factionId, now);
        facts.push_back(std::move(f));
    }

    const WarSideMaintenancePlan plan = PlanWarSideMaintenance(facts, limits);
    out.ok = true;
    for (const auto& r : plan.capRaises)
        if (WarDirector::SetSideSlotCap(db, roomId, r.factionId, r.to))
            out.capsRaised++;
    for (const auto& c : plan.incentiveChanges)
        if (WarDirector::SetSideIncentivised(db, roomId, c.factionId, c.on))
            out.flagsChanged++;
    return out;
}
