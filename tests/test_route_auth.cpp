#include <doctest/doctest.h>

#include "Server/Database.h"
#include "Server/HttpAuth.h"
#include "Server/NetworkServer.h"

#include <cctype>
#include <fstream>
#include <sstream>
#include <string>
#include <unordered_map>

// PLAN-security-hardening task 6 (G20): AddHttpGet/AddHttpPost now require a
// RouteAuth tag as a mandatory argument — a route literally cannot be
// registered without a conscious classification. This is a unit test of that
// mechanism (registration + GetRegisteredRoutes() introspection), not a
// live-socket test of a running server: NetworkServer's route registration
// (AddHttpGet/AddHttpPost/GetRegisteredRoutes) needs no bind()/Start(), so
// this stays a fast, deterministic unit test consistent with the rest of
// this suite. A true "does the real app's route inventory match
// PLAN-security-hardening.md §1.1" snapshot would need either extracting
// lobby_main.cpp's inline route registration into a standalone, dependency-
// light function (it currently isn't — everything lives in main()) or a
// live-process integration test; both are bigger asks than this pass — see
// the task 6 field notes in PLAN-security-hardening.md.

TEST_CASE("NetworkServer.GetRegisteredRoutes reports every registered route with its RouteAuth tag") {
    NetworkServer net;
    net.AddHttpGet("/api/public", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        return {.status = 200};
    });
    net.AddHttpPost("/api/rooms/join", RouteAuth::TokenRequired,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });
    net.AddHttpPost("/api/exec", RouteAuth::AdminOnly,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });
    net.AddHttpPost("/api/rooms/direct", RouteAuth::LocalhostOrAdmin,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });

    auto routes = net.GetRegisteredRoutes();
    REQUIRE(routes.size() == 4);

    auto find = [&](const std::string& method, const std::string& pattern) -> const RouteInfo* {
        for (auto& r : routes)
            if (r.method == method && r.pattern == pattern) return &r;
        return nullptr;
    };

    auto* pub = find("GET", "/api/public");
    REQUIRE(pub != nullptr);
    CHECK(pub->auth == RouteAuth::Public);

    auto* join = find("POST", "/api/rooms/join");
    REQUIRE(join != nullptr);
    CHECK(join->auth == RouteAuth::TokenRequired);

    auto* exec = find("POST", "/api/exec");
    REQUIRE(exec != nullptr);
    CHECK(exec->auth == RouteAuth::AdminOnly);

    auto* direct = find("POST", "/api/rooms/direct");
    REQUIRE(direct != nullptr);
    CHECK(direct->auth == RouteAuth::LocalhostOrAdmin);
}

TEST_CASE("NetworkServer.GetRegisteredRoutes distinguishes GET and POST on the same pattern") {
    NetworkServer net;
    net.AddHttpGet("/api/maps", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        return {.status = 200};
    });
    net.AddHttpPost("/api/maps", RouteAuth::AdminOnly,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });

    auto routes = net.GetRegisteredRoutes();
    REQUIRE(routes.size() == 2);

    int getCount = 0, postCount = 0;
    for (auto& r : routes) {
        CHECK(r.pattern == "/api/maps");
        if (r.method == "GET") { CHECK(r.auth == RouteAuth::Public); getCount++; }
        if (r.method == "POST") { CHECK(r.auth == RouteAuth::AdminOnly); postCount++; }
    }
    CHECK(getCount == 1);
    CHECK(postCount == 1);
}

// --- Real route inventory: the faction routes (PLAN-metalstorm-lobby task 0) ---
//
// The two cases below cover the auth classification of the routes added by
// faction registration. They use two different techniques because the routes
// live in two different places, and it is worth being explicit about which is
// which:
//
//   * POST /api/auth/register is registered by HttpAuth::RegisterEndpoints,
//     a real standalone function, so the test drives production code directly.
//   * GET /api/factions/* and POST /api/admin/set-faction are registered
//     inline in lobby_main.cpp's main(), which a unit test cannot call. Rather
//     than re-registering them here — which would assert only that this test
//     typed the tag it expected, i.e. nothing — the second case reads
//     lobby_main.cpp and asserts the tag at the real registration site. That
//     is coarse (it is a source assertion, not a behavioural one) but it does
//     fail if someone relaxes /api/admin/set-faction from AdminOnly, which is
//     the property worth locking: it is a privileged mutation of a field the
//     product treats as immutable. Replacing it with a behavioural test means
//     extracting main()'s route registration into a dependency-light function
//     — see the note at the top of this file.

TEST_CASE("HttpAuth::RegisterEndpoints tags both auth routes Public") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;

    NetworkServer net;
    HttpAuth::RegisterEndpoints(net, db, factionRegistry);

    auto routes = net.GetRegisteredRoutes();
    auto authOf = [&](const std::string& pattern) -> RouteAuth {
        for (auto& r : routes)
            if (r.method == "POST" && r.pattern == pattern) return r.auth;
        FAIL("route not registered: " << pattern);
        return RouteAuth::AdminOnly;
    };

    // Both must stay Public — you cannot present a token before you have an
    // account, and login is how you get one.
    CHECK(authOf("/api/auth/login") == RouteAuth::Public);
    CHECK(authOf("/api/auth/register") == RouteAuth::Public);
}

TEST_CASE("lobby_main registers the faction routes with the intended RouteAuth") {
    std::ifstream f(std::string(SPRING_SOURCE_DIR) + "/rts/lobby_main.cpp");
    REQUIRE_MESSAGE(f.is_open(), "cannot open rts/lobby_main.cpp");
    std::stringstream buf;
    buf << f.rdbuf();

    // Collapse all whitespace runs to a single space so the assertion is
    // immune to clang-format rewrapping the argument list.
    std::string src;
    src.reserve(buf.str().size());
    bool inSpace = false;
    for (char c : buf.str()) {
        if (std::isspace(static_cast<unsigned char>(c))) {
            if (!inSpace) { src += ' '; inSpace = true; }
        } else {
            src += c;
            inSpace = false;
        }
    }

    // Returns the RouteAuth:: identifier registered against `pattern`, and
    // requires that the pattern is registered exactly once.
    auto tagFor = [&](const std::string& pattern) -> std::string {
        const std::string needle = "\"" + pattern + "\", RouteAuth::";
        const size_t at = src.find(needle);
        REQUIRE_MESSAGE(at != std::string::npos,
            "route not registered in lobby_main.cpp: " << pattern);
        CHECK_MESSAGE(src.find(needle, at + 1) == std::string::npos,
            "route registered more than once: " << pattern);
        const size_t start = at + needle.size();
        size_t end = start;
        while (end < src.size() && (std::isalnum(static_cast<unsigned char>(src[end])))) end++;
        return src.substr(start, end - start);
    };

    CHECK(tagFor("/api/factions/*") == "Public");
    // The sign-up form fetches this before the player has an account.

    CHECK(tagFor("/api/admin/set-faction") == "AdminOnly");
    // faction is a permanent account-level allegiance with no player-facing
    // change flow; this is the only route that can rewrite it after sign-up.
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/auth/logout — PLAN-endtoend.md D45.
//
// These drive the real handler out of the real registration, via
// NetworkServer::FindPostHandlerForTest, so they assert behaviour rather
// than the tag alone. Every case is a way the route can be wrong in a
// direction that strands a player on an account:
//   - not revoking → clearing localStorage is not a logout, the token
//     stays live for its full 24h in anything that copied it;
//   - 401 on a dead token → the button fails at exactly the moment it is
//     needed most, and the client cannot complete the logout;
//   - revoking on a header it did not parse → a Basic-auth caller (or a
//     malformed header) reported success it never performed.

/// HttpResponse::body is a byte vector; every assertion below is on JSON.
static std::string BodyText(const HttpResponse& resp) {
    return std::string(resp.body.begin(), resp.body.end());
}

static HttpResponse PostLogout(NetworkServer& net, const std::string& authHeader) {
    auto handler = net.FindPostHandlerForTest("/api/auth/logout");
    REQUIRE_MESSAGE(static_cast<bool>(handler), "/api/auth/logout is not registered");
    HttpRequestHeaders headers;
    headers.authorization = authHeader;
    return handler("/api/auth/logout", "{}", headers);
}

TEST_CASE("POST /api/auth/logout revokes the presented session token") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;
    NetworkServer net;
    HttpAuth::RegisterEndpoints(net, db, factionRegistry);

    const int64_t userId = db.CreateUser("d45", Crypto::HashPassword("pw"),
                                         "player", /*isDev=*/false, "compact");
    REQUIRE(userId != 0);
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(db.CreateSession(userId, token));
    REQUIRE(db.ValidateSession(token) == userId);

    const HttpResponse resp = PostLogout(net, "Bearer " + token);
    CHECK(resp.status == 200);
    CHECK(BodyText(resp).find("\"revoked\":true") != std::string::npos);

    // The property the whole row is about: the token is dead server-side,
    // not merely forgotten by the browser that held it.
    CHECK(db.ValidateSession(token) == 0);
}

TEST_CASE("POST /api/auth/logout succeeds on a token that is already gone") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;
    NetworkServer net;
    HttpAuth::RegisterEndpoints(net, db, factionRegistry);

    // A logout must be completable with a token the server has never seen —
    // otherwise an expired session is a session you cannot leave.
    const HttpResponse resp = PostLogout(net, "Bearer not-a-real-token");
    CHECK(resp.status == 200);
    CHECK(BodyText(resp).find("\"revoked\":false") != std::string::npos);
}

TEST_CASE("POST /api/auth/logout reports revoked:false for a header it cannot parse") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;
    NetworkServer net;
    HttpAuth::RegisterEndpoints(net, db, factionRegistry);

    const int64_t userId = db.CreateUser("d45basic", Crypto::HashPassword("pw"),
                                         "player", /*isDev=*/false, "union");
    REQUIRE(userId != 0);
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(db.CreateSession(userId, token));

    // Basic auth holds no session row (ValidateAuth logs it in per request),
    // an empty Bearer names no token, and no header names nothing at all.
    // None of the three may revoke anything — least of all somebody else's
    // live session.
    for (const std::string& header : {std::string("Basic ZDQ1YmFzaWM6cHc="),
                                      std::string("Bearer "),
                                      std::string("")}) {
        const HttpResponse resp = PostLogout(net, header);
        CHECK(resp.status == 200);
        CHECK(BodyText(resp).find("\"revoked\":false") != std::string::npos);
    }
    CHECK(db.ValidateSession(token) == userId);
}

TEST_CASE("HttpAuth::RegisterEndpoints tags /api/auth/logout Public") {
    Database db;
    REQUIRE(db.Open(":memory:"));
    const std::unordered_map<std::string, FactionData::FactionInfo> factionRegistry;
    NetworkServer net;
    HttpAuth::RegisterEndpoints(net, db, factionRegistry);

    // Public, not TokenRequired: DispatchPost would 401 a dead token before
    // the handler ran, which is the one case the route exists to survive.
    // The handler does its own parsing and revokes only what the caller
    // presents, so there is nothing a token would authorise.
    bool found = false;
    for (auto& r : net.GetRegisteredRoutes()) {
        if (r.method == "POST" && r.pattern == "/api/auth/logout") {
            found = true;
            CHECK(r.auth == RouteAuth::Public);
        }
    }
    CHECK(found);
}
