// CacheControl — engine-wide HTTP cache management.
//
// Build stamp: unique per build (git hash + timestamp, regenerated at build
// time — see cmake/GenerateBuildStamp.cmake). Append ?v=<stamp> to asset
// URLs for automatic cache-busting on new deployments. Immutable caching
// means browsers keep assets forever and only re-fetch when the stamp
// changes.
//
// Dev mode: --no-cache flag disables all HTTP caching.
//
// Every HTTP response goes through Header()/StaticAssetHeader()
// etc. to get the right Cache-Control value.

#pragma once

#include <string>
#include <atomic>

#if __has_include("BuildStamp.h")
#include "BuildStamp.h"
#endif

namespace CacheControl {

/// Build stamp — unique per build, used as ?v= query param.
/// Generated at build time from git hash + timestamp (BuildStamp.h).
inline const char* BuildStamp() {
#ifdef SPRING_BUILD_STAMP
    return SPRING_BUILD_STAMP;
#else
    return "dev";
#endif
}

/// Enable/disable no-cache mode (--no-cache CLI flag).
inline std::atomic<bool>& NoCacheFlag() {
    static std::atomic<bool> flag{false};
    return flag;
}

inline void SetNoCache(bool enabled) { NoCacheFlag().store(enabled); }
inline bool IsNoCache() { return NoCacheFlag().load(); }

/// Static assets (maps, models, textures) — with ?v= param these
/// can be cached forever since the URL changes on new builds.
/// No-cache mode: no-store.
inline std::string StaticAssetHeader() {
    return IsNoCache() ? "no-store" : "public, max-age=31536000, immutable";
}

/// Semi-static metadata (map list, game list, manifest).
/// 5 minutes in production, no-store in dev.
inline std::string MetadataHeader() {
    return IsNoCache() ? "no-store" : "public, max-age=300";
}

/// Dynamic API responses — never cached.
inline std::string DynamicHeader() {
    return "no-store";
}

} // namespace CacheControl
