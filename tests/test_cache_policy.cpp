/**
 * Serving-cache policy — PLAN-protocol-guard task 5.
 *
 * The audit behind this file: `immutable` (RFC 8246) is not "cache for a
 * year", it is "never revalidate, including on an explicit reload". The whole
 * safety argument for the immutable tier is `?v=<build stamp>` — with it the
 * URL names the build it belongs to and the stale copy is simply never
 * requested again; without it there is no client-side remedy at all, and the
 * one the rest of this lane built (task 4's reload) cannot help either.
 *
 * Two lobby endpoints answered `StaticAssetHeader()` unconditionally while
 * being composed per request (`metadata.json` from the maps DB,
 * `resources.json` from the game's files), and two of their three client
 * callers do not stamp. So the decision now reads the request instead of
 * trusting the caller, and it lives here — pure — because the sites
 * themselves sit inside `RunLobby`, behind a socket, a DB and a route table.
 */
#include <doctest/doctest.h>

#include "Server/CacheControl.h"

#include <string>

namespace {

/// Restores the process-wide --no-cache flag whatever a subcase does with it.
struct NoCacheScope {
    bool prev = CacheControl::IsNoCache();
    explicit NoCacheScope(bool enabled) { CacheControl::SetNoCache(enabled); }
    ~NoCacheScope() { CacheControl::SetNoCache(prev); }
};

bool IsImmutable(const std::string& header) {
    return header.find("immutable") != std::string::npos;
}

} // namespace

TEST_CASE("task 5: the immutable tier is earned by the request, not assumed") {
    NoCacheScope prod(false);

    SUBCASE("a stamped request gets the immutable tier") {
        CHECK(CacheControl::QueryCarriesVersion("v=abc1234-20260815010203"));
        CHECK(IsImmutable(CacheControl::VersionedAssetHeader(
            "v=abc1234-20260815010203")));
    }

    SUBCASE("an unstamped request is never answered immutable") {
        // This is the defect: `fetchMapDataHttp` and the game-processor's
        // viewport sizing both fetch metadata.json bare, so under the old
        // header a browser froze a map's metadata for a year.
        CHECK_FALSE(CacheControl::QueryCarriesVersion(""));
        CHECK_FALSE(IsImmutable(CacheControl::VersionedAssetHeader("")));
        CHECK(CacheControl::VersionedAssetHeader("") ==
              CacheControl::MetadataHeader());
    }

    SUBCASE("the stamp is recognised in any position") {
        CHECK(CacheControl::QueryCarriesVersion("lod=2&v=abc"));
        CHECK(CacheControl::QueryCarriesVersion("v=abc&lod=2"));
        CHECK(CacheControl::QueryCarriesVersion("a=1&v=abc&b=2"));
    }

    SUBCASE("a parameter that merely ends in v is not the stamp") {
        // A substring search for "v=" would accept every one of these, and
        // the cost of accepting one is a year of unrevalidated staleness.
        CHECK_FALSE(CacheControl::QueryCarriesVersion("sv=abc"));
        CHECK_FALSE(CacheControl::QueryCarriesVersion("vv=abc"));
        CHECK_FALSE(CacheControl::QueryCarriesVersion("rev=abc"));
        CHECK_FALSE(CacheControl::QueryCarriesVersion("x=1&sv=abc"));
    }

    SUBCASE("an empty stamp is not a stamp") {
        // `stampUrl()` never emits this, but a hand-built URL can, and `?v=`
        // with no value identifies no build.
        CHECK_FALSE(CacheControl::QueryCarriesVersion("v="));
        CHECK_FALSE(CacheControl::QueryCarriesVersion("a=1&v=&b=2"));
    }

    SUBCASE("--no-cache wins over a stamp") {
        // A dev stack stamps like any other client; the operator flag is the
        // one that has to be able to say no.
        NoCacheScope dev(true);
        CHECK(CacheControl::VersionedAssetHeader("v=abc") == "no-store");
        CHECK(CacheControl::VersionedAssetHeader("") == "no-store");
    }
}

TEST_CASE("task 5: the three tiers say what docs/caching.md says they say") {
    // Pins the strings themselves: the case above is only meaningful while
    // the metadata tier is actually revalidatable and the static tier is not.
    NoCacheScope prod(false);
    CHECK(CacheControl::StaticAssetHeader() ==
          "public, max-age=31536000, immutable");
    CHECK(CacheControl::MetadataHeader() == "public, max-age=300");
    CHECK_FALSE(IsImmutable(CacheControl::MetadataHeader()));
    CHECK(CacheControl::DynamicHeader() == "no-store");
}
