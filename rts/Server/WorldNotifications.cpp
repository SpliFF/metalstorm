#include "WorldNotifications.h"

#include <set>

#include <sqlite3.h>

#include "WorldFactions.h"
#include "WorldStats.h"

const char* WorldNotificationKindToString(WorldNotificationKind k) {
  switch (k) {
    case WorldNotificationKind::StagingOpened:       return "opened";
    case WorldNotificationKind::StagingMaterialised: return "materialised";
    case WorldNotificationKind::StagingCancelled:    return "cancelled";
    case WorldNotificationKind::StagingFailed:       return "failed";
  }
  return "opened";
}

std::string WorldNotificationHeadline(WorldNotificationKind kind,
                                      const std::string& poiName) {
  const std::string name = poiName.empty() ? "a point of interest" : poiName;
  switch (kind) {
    case WorldNotificationKind::StagingOpened:
      return "Staging has opened at " + name + ".";
    case WorldNotificationKind::StagingMaterialised:
      return "Staging at " + name + " has closed — the battle has begun.";
    case WorldNotificationKind::StagingCancelled:
      return "Staging at " + name + " was cancelled.";
    case WorldNotificationKind::StagingFailed:
      return "Staging at " + name + " closed without a battle.";
  }
  return "";
}

nlohmann::json WorldNotificationToJson(const WorldNotificationEvent& ev) {
  nlohmann::json j;
  j["world"]           = ev.worldId;
  j["poi"]             = ev.poiId;
  j["poiName"]         = ev.poiName;
  j["kind"]            = WorldNotificationKindToString(ev.kind);
  j["attackerFaction"] = ev.attackerFactionId;
  j["defenderFaction"] = ev.defenderFactionId;
  j["stagingId"]       = ev.stagingId;
  j["worldMs"]         = ev.worldMs;
  j["headline"]        = ev.headline.empty()
      ? WorldNotificationHeadline(ev.kind, ev.poiName)
      : ev.headline;
  return j;
}

std::vector<int64_t> WorldNotificationRecipients(sqlite3* db,
                                                  const std::string& worldId,
                                                  const std::string& attackerFactionId,
                                                  const std::string& defenderFactionId,
                                                  const std::string& poiId) {
  std::set<int64_t> ids;
  if (!attackerFactionId.empty())
    for (const auto& m : WorldFactions::MembersOf(db, worldId, attackerFactionId))
      ids.insert(m.accountId);
  if (!defenderFactionId.empty())
    for (const auto& m : WorldFactions::MembersOf(db, worldId, defenderFactionId))
      ids.insert(m.accountId);
  if (!poiId.empty())
    for (const auto& c : WorldStats::CommandersAtPoi(db, worldId, poiId))
      ids.insert(c.accountId);
  return std::vector<int64_t>(ids.begin(), ids.end());
}
