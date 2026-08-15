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
#include <string_view>
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

/// True when this raw query string carries the client's build stamp (`v=`,
/// appended by `stampUrl()` — see docs/caching.md). That parameter is the
/// entire justification for the immutable tier: it makes the URL name the
/// build it belongs to, so the browser is never asked for the old one again.
///
/// Takes the RAW query (`NetworkServer::CurrentQueryString()`, everything
/// after '?', undecoded), because handlers are given the decoded path only.
inline bool QueryCarriesVersion(std::string_view query) {
    size_t pos = 0;
    while (pos <= query.size()) {
        const size_t amp = query.find('&', pos);
        const std::string_view pair = query.substr(
            pos, amp == std::string_view::npos ? std::string_view::npos : amp - pos);
        // `v=` with a non-empty value. `vv=1` / `sv=1` / a bare `v=` are not it.
        if (pair.size() > 2 && pair[0] == 'v' && pair[1] == '=') return true;
        if (amp == std::string_view::npos) break;
        pos = amp + 1;
    }
    return false;
}

/// Header for a response whose URL is STABLE unless the caller stamps it —
/// composed metadata (`metadata.json`, `resources.json`) rather than a file
/// whose name contains its own hash.
///
/// PLAN-protocol-guard task 5 (serving-cache audit). These endpoints answered
/// `StaticAssetHeader()` unconditionally, and two of the three client callers
/// do not stamp them: `immutable` (RFC 8246) tells the browser not to
/// revalidate **even on an explicit reload**, so a map's metadata composed
/// from the maps DB was frozen in every browser that had ever loaded it for a
/// year, with no client-side remedy. Immutability is now decided by what the
/// request actually claimed rather than by what the caller was supposed to do:
/// stamped → the immutable tier it was designed for, unstamped → the metadata
/// tier, which revalidates.
inline std::string VersionedAssetHeader(std::string_view query) {
    return QueryCarriesVersion(query) ? StaticAssetHeader() : MetadataHeader();
}

} // namespace CacheControl
