// StatsDump — see StatsDump.h. Pure JSON assembly + determinism hash, plus
// the one platform-coupled (but engine-independent) RSS reader.

#include "Server/StatsDump.h"

#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <fstream>

#include <nlohmann/json.hpp>

#if defined(__APPLE__) || defined(__linux__)
#include <sys/resource.h>
#endif

namespace statsdump {

namespace {

// FNV-1a-style fold of one float's bit pattern into a running hash. Folding
// raw bits (not the float value) means NaN/-0.0 quirks can't silently
// collapse two different-but-equal-looking states into the same hash.
inline void FoldBits(uint64_t& h, uint32_t bits) {
    h ^= bits;
    h *= 0x100000001b3ULL;  // FNV prime
}

inline uint32_t FloatBits(float f) {
    uint32_t bits;
    std::memcpy(&bits, &f, sizeof(bits));
    return bits;
}

}  // namespace

uint64_t ComputeStateHash(const std::vector<UnitDigest>& units, uint64_t rngState) {
    uint64_t h = 0xcbf29ce484222325ULL;  // FNV offset basis
    FoldBits(h, static_cast<uint32_t>(units.size()));
    for (const auto& u : units) {
        FoldBits(h, static_cast<uint32_t>(u.id));
        FoldBits(h, static_cast<uint32_t>(u.team));
        FoldBits(h, FloatBits(u.x));
        FoldBits(h, FloatBits(u.y));
        FoldBits(h, FloatBits(u.z));
        FoldBits(h, FloatBits(u.health));
    }
    FoldBits(h, static_cast<uint32_t>(rngState));
    FoldBits(h, static_cast<uint32_t>(rngState >> 32));
    return h;
}

namespace {

nlohmann::json TeamToJson(const TeamSnapshot& t) {
    return {
        {"teamId", t.teamId},
        {"allyTeam", t.allyTeam},
        {"dead", t.dead},
        {"numUnits", t.numUnits},
        {"metal", t.metal},
        {"energy", t.energy},
        {"metalIncome", t.metalIncome},
        {"energyIncome", t.energyIncome},
        {"metalExpense", t.metalExpense},
        {"energyExpense", t.energyExpense},
        {"damageDealt", t.damageDealt},
        {"damageReceived", t.damageReceived},
        {"unitsProduced", t.unitsProduced},
        {"unitsDied", t.unitsDied},
        {"unitsKilled", t.unitsKilled},
    };
}

nlohmann::json WeaponToJson(const WeaponStats& w) {
    return {
        {"weaponDefId", w.weaponDefId},
        {"volleys", w.volleys},
        {"kills", w.kills},
        {"damage", w.damage},
    };
}

// Fixed-width lowercase hex, not a JSON number — a >2^53 hash would lose
// precision through any double-based JSON parser (Node/Python).
std::string HashToHex(uint64_t h) {
    char buf[17];
    snprintf(buf, sizeof(buf), "%016" PRIx64, h);
    return std::string(buf, 16);
}

nlohmann::json SnapshotToJson(const Snapshot& s) {
    nlohmann::json teams = nlohmann::json::array();
    for (const auto& t : s.teams)
        teams.push_back(TeamToJson(t));
    nlohmann::json weapons = nlohmann::json::array();
    for (const auto& w : s.weapons)
        weapons.push_back(WeaponToJson(w));
    return {
        {"frame", s.frame},
        {"gameSeconds", s.gameSeconds},
        {"wallSeconds", s.wallSeconds},
        {"stateHash", HashToHex(s.stateHash)},
        {"simFps", s.simFps},
        {"rssKb", s.rssKb},
        {"luaHeapKb", s.luaHeapKb},
        {"teams", teams},
        {"weapons", weapons},
    };
}

}  // namespace

std::string BuildDumpJson(const FinalDump& dump) {
    nlohmann::json snapshots = nlohmann::json::array();
    for (const auto& s : dump.snapshots)
        snapshots.push_back(SnapshotToJson(s));

    nlohmann::json j = {
        {"status", dump.status},
        {"frame", dump.frame},
        {"gameSeconds", dump.gameSeconds},
        {"wallSeconds", dump.wallSeconds},
        {"snapshots", snapshots},
    };
    return j.dump(2);
}

bool WriteDumpFile(const std::string& path, const FinalDump& dump, std::string& err) {
    try {
        std::ofstream f(path, std::ios::out | std::ios::trunc);
        if (!f) {
            err = "cannot open stats dump path for writing: " + path;
            return false;
        }
        f << BuildDumpJson(dump);
        if (!f) {
            err = "write error while flushing stats dump: " + path;
            return false;
        }
        return true;
    } catch (const std::exception& e) {
        err = std::string("stats dump write failed: ") + e.what();
        return false;
    }
}

int64_t GetRssKb() {
#if defined(__APPLE__) || defined(__linux__)
    struct rusage ru;
    if (getrusage(RUSAGE_SELF, &ru) != 0)
        return 0;
    // ru_maxrss is KB on Linux, bytes on macOS.
#if defined(__APPLE__)
    return static_cast<int64_t>(ru.ru_maxrss) / 1024;
#else
    return static_cast<int64_t>(ru.ru_maxrss);
#endif
#else
    return 0;
#endif
}

}  // namespace statsdump
