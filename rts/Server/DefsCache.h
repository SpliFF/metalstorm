// DefsCache — bake UnitDefs/WeaponDefs FlatBuffer payloads to disk so
// the lobby can serve them as static, browser-cacheable HTTP responses.
//
// Why this exists: ZK (and any non-trivial Spring game) post-processes
// the def tables based on modOptions inside `gamedata/defs.lua`. The
// resulting tables are per-(gameId, version, modOptions). They're
// immutable for the lifetime of a game-server process, so we can
// serialize them once at startup, write to a content-addressed path,
// and let every connected client (and every future session with the
// same modOptions) fetch via HTTP with `Cache-Control: immutable`.
//
// The cache key is a 64-bit XXH3 of the canonical inputs, hex-encoded
// (16 chars). Path layout:
//
//   data/games/{gameId}/cache/defs/{cacheKey}/unitdefs.bin
//   data/games/{gameId}/cache/defs/{cacheKey}/weapondefs.bin
//
// The lobby's existing `/api/games/data/*` static handler serves these
// without further wiring.
#pragma once

#include "lib/xxhash/xxh3.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace DefsCache {

/// Compute the content-addressed cache key for the given game/version/modOptions.
/// Stable across runs: keys are sorted before hashing. Templated on the map
/// type because callers pass either std::unordered_map or spring::unordered_map.
template<typename ModOptionsMap>
inline std::string ComputeCacheKey(
    const std::string& gameId,
    const std::string& gameVersion,
    const ModOptionsMap& modOptions)
{
    // Build a canonical string: gameId\nversion\nkey=value (sorted)\n...
    // Sorting is the only thing that makes the hash stable across
    // unordered iteration orders.
    std::vector<std::pair<std::string, std::string>> sorted;
    sorted.reserve(modOptions.size());
    for (const auto& kv : modOptions)
        sorted.emplace_back(kv.first, kv.second);
    std::sort(sorted.begin(), sorted.end(),
        [](const auto& a, const auto& b) { return a.first < b.first; });

    std::string canonical;
    canonical.reserve(64 + sorted.size() * 32);
    // Schema version. Bump this whenever GameUnitDef / GameWeaponDef in
    // schemas/protocol.fbs gains or removes fields, or whenever the
    // Build* code in Protocol.h changes which fields it populates. The
    // version is mixed into the cache key so old cached .bin files (and
    // browser HTTP cache entries keyed on the URL) become unreachable
    // after a schema change. Without this, a stale cache from a prior
    // schema would silently shadow the newly-bakable bytes.
    //
    // 2026-05-09: bumped past v6 after texture1/2/3 in GameWeaponDef
    // changed from bare logical names to fully-qualified URLs (Issue 3
    // resolver). Keep this string in sync with the .cpp side and any
    // other ComputeCacheKey copy — the lobby and the server both
    // inline the function body, so a single-site bump misses one.
    canonical += "schemaV7-protocol";
    canonical += '\n';
    canonical += gameId;
    canonical += '\n';
    canonical += gameVersion;
    canonical += '\n';
    for (const auto& kv : sorted) {
        canonical += kv.first;
        canonical += '=';
        canonical += kv.second;
        canonical += '\n';
    }

    const XXH64_hash_t h = XXH3_64bits(canonical.data(), canonical.size());
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx",
                  static_cast<unsigned long long>(h));
    return std::string(buf, 16);
}

/// Absolute (relative-to-cwd) path to the directory holding the bin files.
std::string CacheDir(const std::string& gameId, const std::string& cacheKey);

/// Bake the UnitDefs/WeaponDefs FlatBuffer payloads to disk if not
/// already present for this cacheKey. Skips writing if files already
/// exist (cheap stat) — the second room with the same modOptions is a
/// no-op. Returns true on success (or if the cache was already warm).
///
/// `unitDefBytes` / `weaponDefBytes` are the wire payloads as produced
/// by Protocol::BuildGameUnitDefs / BuildGameWeaponDefs (server-message
/// envelope wrapper included; client deserialization is shared between
/// HTTP fetch and any future stream channel).
bool WriteIfMissing(
    const std::string& gameId,
    const std::string& cacheKey,
    const std::vector<uint8_t>& unitDefBytes,
    const std::vector<uint8_t>& weaponDefBytes);

} // namespace DefsCache
