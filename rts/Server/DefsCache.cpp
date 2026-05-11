#include "DefsCache.h"

#include "lib/xxhash/xxh3.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <fstream>

namespace DefsCache {

// Schema version. Bump this whenever GameUnitDef / GameWeaponDef in
// schemas/protocol.fbs gains or removes fields. The version is mixed
// into the cache key so old cached .bin files (and browser HTTP cache
// entries keyed on the URL) become unreachable after a schema change.
// Without this, a stale cache from a prior schema would silently
// shadow the newly-bakable bytes.
// 2026-05-10: v10 — GameWeaponDef gained ceg_tag, explosion_generator,
// bounce_explosion_generator (strings); a new GameCegDefs message
// was added carrying parsed CEG defs. The bake now writes a third
// `cegdefs.bin` next to unitdefs.bin / weapondefs.bin. Bumping
// invalidates older two-file caches so the lobby re-bakes with the
// third file.
static constexpr const char* DEFS_SCHEMA_VERSION = "v10";

std::string ComputeCacheKey(
    const std::string& gameId,
    const std::string& gameVersion,
    const std::unordered_map<std::string, std::string>& modOptions)
{
    // Build a canonical string: schemaV\ngameId\nversion\nkey=value (sorted)\n...
    // Sorting is the only thing that makes the hash stable across
    // unordered_map iteration orders.
    std::vector<std::string> keys;
    keys.reserve(modOptions.size());
    for (const auto& kv : modOptions) keys.push_back(kv.first);
    std::sort(keys.begin(), keys.end());

    std::string canonical;
    canonical.reserve(64 + modOptions.size() * 32);
    // Schema string. Must stay byte-for-byte identical with the
    // ComputeCacheKey copy in DefsCache.h — the two were drifting
    // apart and a single-site bump produced different cache keys
    // depending on which translation unit linked first.
    canonical += "schemaV10-protocol";
    canonical += '\n';
    canonical += gameId;
    canonical += '\n';
    canonical += gameVersion;
    canonical += '\n';
    for (const auto& k : keys) {
        canonical += k;
        canonical += '=';
        canonical += modOptions.at(k);
        canonical += '\n';
    }

    const XXH64_hash_t h = XXH3_64bits(canonical.data(), canonical.size());
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx",
                  static_cast<unsigned long long>(h));
    return std::string(buf, 16);
}

std::string CacheDir(const std::string& gameId, const std::string& cacheKey)
{
    return "data/games/" + gameId + "/cache/defs/" + cacheKey;
}

static bool WriteFile(const std::filesystem::path& path,
                      const std::vector<uint8_t>& bytes)
{
    // Write to a sibling temp path then rename atomically — avoids a
    // partial file being served if the process crashes mid-write or
    // another room is racing on the same cacheKey.
    std::filesystem::path tmp = path;
    tmp += ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f.write(reinterpret_cast<const char*>(bytes.data()),
                static_cast<std::streamsize>(bytes.size()));
        if (!f) return false;
    }
    std::error_code ec;
    std::filesystem::rename(tmp, path, ec);
    if (ec) {
        // Rename across mounts can fail; copy + remove is the fallback.
        std::filesystem::copy_file(tmp, path,
            std::filesystem::copy_options::overwrite_existing, ec);
        std::filesystem::remove(tmp);
        if (ec) return false;
    }
    return true;
}

bool WriteIfMissing(
    const std::string& gameId,
    const std::string& cacheKey,
    const std::vector<uint8_t>& unitDefBytes,
    const std::vector<uint8_t>& weaponDefBytes,
    const std::vector<uint8_t>& cegDefBytes)
{
    namespace fs = std::filesystem;
    const fs::path dir = CacheDir(gameId, cacheKey);
    const fs::path udPath = dir / "unitdefs.bin";
    const fs::path wdPath = dir / "weapondefs.bin";
    const fs::path cdPath = dir / "cegdefs.bin";

    const bool udExists = fs::exists(udPath);
    const bool wdExists = fs::exists(wdPath);
    const bool cdExists = fs::exists(cdPath);
    if (udExists && wdExists && cdExists) return true;

    std::error_code ec;
    fs::create_directories(dir, ec);
    if (ec) return false;

    if (!udExists && !WriteFile(udPath, unitDefBytes)) return false;
    if (!wdExists && !WriteFile(wdPath, weaponDefBytes)) return false;
    // CEG payload is optional in semantics but always written so the
    // browser fetch path doesn't see a 404; an empty GameCegDefs frame
    // is still ~16 bytes after envelope+headers, which is harmless.
    if (!cdExists && !WriteFile(cdPath, cegDefBytes)) return false;
    return true;
}

} // namespace DefsCache
