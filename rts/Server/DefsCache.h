// DefsCache — bake brotli-compressed Lua-source def payloads to disk
// so the static handler can serve them as cacheable HTTP responses
// (browser auto-decompresses via Content-Encoding: br).
//
// Why this exists: ZK (and any non-trivial Spring game) post-processes
// the def tables based on modOptions inside `gamedata/defs.lua`. The
// resulting tables are per-(gameId, version, modOptions). They're
// immutable for the lifetime of a game-server process, so we can
// serialize them once at startup, write to a content-addressed path,
// and let every connected client (and every future session with the
// same modOptions) fetch via HTTP.
//
// The cache key is a 64-bit XXH3 of the canonical inputs, hex-encoded
// (16 chars). Path layout:
//
//   data/games/{gameId}/cache/defs/{cacheKey}/unitdefs.lua.br
//   data/games/{gameId}/cache/defs/{cacheKey}/weapondefs.lua.br
//   data/games/{gameId}/cache/defs/{cacheKey}/cegdefs.lua.br
//   data/games/{gameId}/cache/defs/{cacheKey}/featuredefs.lua.br
//
// Dev: served by client/vite-static-data-plugin.ts with
// `Content-Encoding: br`. Production: nginx/CDN — see
// PLAN-static-serving.md.
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
    // Schema version. Bump this whenever the on-wire def shape
    // changes — the version is mixed into the cache key so old
    // cached files (and browser HTTP cache entries keyed on URL)
    // become unreachable after a schema change. Keep this string
    // byte-for-byte identical with the copy in DefsCache.cpp.
    //
    // 2026-05-25: v14-lua — defs migrated from FlatBuffer .bin to
    // brotli-compressed Lua source (.lua.br). Pre-v14 caches still
    // exist on disk as orphans; `rm -rf data/games/*/cache/defs/`
    // reclaims them. See PLAN-defs.md.
    canonical += "schemaV14-lua";
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

/// Bake the brotli-compressed Lua-source payloads to disk if not
/// already present for this cacheKey. Skips writing when files
/// already exist (cheap stat) — the second room with the same
/// modOptions is a no-op. Returns true on success (or if the cache
/// was already warm).
///
/// Each vector is the brotli-compressed bytes of a Lua source string
/// produced by LuaDefsSerializer::SerializeUnitDefs etc. and run
/// through CompressBrotli. They land on disk as `unitdefs.lua.br`,
/// `weapondefs.lua.br`, `cegdefs.lua.br`, `featuredefs.lua.br`.
/// CEG / feature payloads may be empty when the game has none —
/// the file is still written so the client's eager fetch doesn't 404.
bool WriteIfMissing(
    const std::string& gameId,
    const std::string& cacheKey,
    const std::vector<uint8_t>& unitDefBytes,
    const std::vector<uint8_t>& weaponDefBytes,
    const std::vector<uint8_t>& cegDefBytes,
    const std::vector<uint8_t>& featureDefBytes);

} // namespace DefsCache
