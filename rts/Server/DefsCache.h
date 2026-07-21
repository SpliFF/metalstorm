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

/// Content-aware cache key: XXH3 of the schema version + gameId + version +
/// sorted modOptions + the ACTUAL serialized def payloads.
///
/// This supersedes ComputeCacheKey for the on-disk bake path. The old key
/// hashed only gameId/version/modOptions, so it was content-blind: editing
/// or adding a `units/*.lua` file (or dropping a `.gltf` into models/ so a
/// def's model_url flips from "" to a URL) did NOT rotate the key. The
/// client then kept fetching a frozen `unitdefs.lua.br` whose def_ids no
/// longer matched the live server def_ids — every native model rendered as a
/// fallback shape and, worse, the wrong def could resolve for a given id.
///
/// By hashing the emitted payloads themselves, ANY change to the defs the
/// client will receive rotates the key and forces a fresh bake at a new URL,
/// while identical defs reuse the same key (warm cache + browser cache hit).
/// Post-processing (modOptions-driven) is captured automatically because it
/// is already baked into the payload bytes.
template<typename ModOptionsMap>
inline std::string ComputeContentKey(
    const std::string& gameId,
    const std::string& gameVersion,
    const ModOptionsMap& modOptions,
    std::string_view unitDefSrc,
    std::string_view weaponDefSrc,
    std::string_view cegDefSrc,
    std::string_view featureDefSrc)
{
    std::vector<std::pair<std::string, std::string>> sorted;
    sorted.reserve(modOptions.size());
    for (const auto& kv : modOptions)
        sorted.emplace_back(kv.first, kv.second);
    std::sort(sorted.begin(), sorted.end(),
        [](const auto& a, const auto& b) { return a.first < b.first; });

    XXH3_state_t* state = XXH3_createState();
    XXH3_64bits_reset(state);
    // Keep this schema tag byte-for-byte in sync with ComputeCacheKey's.
    auto mix = [&](std::string_view s) {
        XXH3_64bits_update(state, s.data(), s.size());
        XXH3_64bits_update(state, "\n", 1);
    };
    mix("schemaV14-lua");
    mix(gameId);
    mix(gameVersion);
    for (const auto& kv : sorted) { mix(kv.first); mix(kv.second); }
    // The payloads. Length-tagless concatenation is safe here because each
    // is a self-delimiting Lua table literal and we mix a separator between.
    mix(unitDefSrc);
    mix(weaponDefSrc);
    mix(cegDefSrc);
    mix(featureDefSrc);

    const XXH64_hash_t h = XXH3_64bits_digest(state);
    XXH3_freeState(state);
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
/// Pass `overwrite=true` to rewrite the files even when present. The
/// cache key is content-blind (only gameId/version/modOptions —
/// adding or editing a `units/*.lua` file does NOT rotate it), so
/// without an overwrite the on-disk payload the client fetches stays
/// frozen at its first bake. `--no-cache` (dev) sets overwrite so
/// edited defs actually reach the browser on the next launch.
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
    const std::vector<uint8_t>& featureDefBytes,
    bool overwrite = false);

} // namespace DefsCache
