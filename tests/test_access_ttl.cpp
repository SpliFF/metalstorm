#include <doctest/doctest.h>

#include "Server/AuthTokens.h"
#include "Server/Crypto.h"
#include "Server/Database.h"
#include "Server/HttpAuth.h"
#include "Server/NetworkServer.h"

#include <sqlite3.h>

#include <string>
#include <unordered_map>

// PLAN-metalstorm-lobby.md §7.2 — 8a-follow-on: the access TTL went 24 h → 1 h.
//
// Task 8a deliberately left it at 24 h and wrote down why: the constant looked
// like a one-line change and was not. These cases pin the two halves of what
// made it not a one-liner, plus the route change the client needs to survive
// it. Each is something that can be silently wrong rather than a restatement
// of the code:
//
//  1. **The TTL had TWO definitions and only one of them was named.** The
//     lobby passed `HttpAuth::kAccessTtlSeconds` explicitly; the game server's
//     reconnect path took `Database::ValidateSession`'s 86400 DEFAULT
//     ARGUMENT. They agreed by coincidence, so shortening the named one alone
//     would have left every game server — the process exposed on a per-room
//     port — honouring a day-old bearer token, which is precisely the hole a
//     short TTL exists to close. Nothing about that failure is visible from
//     either call site.
//  2. **/api/auth/validate has to report the REMAINING life, not the TTL.**
//     It is the only auth route that reports on a session it did not mint, and
//     it is the reload path. A client that arms its renewal timer against the
//     full TTL after reloading 50 minutes in schedules the renewal for half an
//     hour after the token it is renewing has already died — and the symptom
//     is a mid-match reconnect asking for a password, an hour later, on a code
//     path nobody was watching.
//  3. **The two session-minting guest routes never reported a lifetime at
//     all**, so a guest was the one account kind whose client could not arm a
//     timer even in principle.
//
// The client half (read-at-use accessor, renewal timer, cross-tab lock) is in
// client/src/lobby/auth-tokens.test.ts.

namespace {

struct AuthFixture {
    Database db;
    NetworkServer net;
    const std::unordered_map<std::string, FactionData::FactionInfo> factions;

    AuthFixture() {
        REQUIRE(db.Open(":memory:"));
        HttpAuth::RegisterEndpoints(net, db, factions);
    }

    int64_t MakeUser(const std::string& name) {
        const int64_t id = db.CreateUser(name, Crypto::HashPassword("pw"),
                                         "player", /*isDev=*/false, "compact");
        REQUIRE(id != 0);
        return id;
    }

    /// Age a session by rewriting its `created_at`. The table stores a SQLite
    /// datetime string rather than an absolute unix time, so this is how the
    /// clock is driven here (see the note in HttpAuth.h's NowUnix).
    void BackdateSession(const std::string& token, int seconds) {
        const std::string sql =
            "UPDATE sessions SET created_at = datetime('now', '-" +
            std::to_string(seconds) + " seconds') WHERE token = ?";
        sqlite3_stmt* stmt = nullptr;
        REQUIRE(sqlite3_prepare_v2(db.Handle(), sql.c_str(), -1, &stmt,
                                   nullptr) == SQLITE_OK);
        sqlite3_bind_text(stmt, 1, token.c_str(), -1, SQLITE_TRANSIENT);
        REQUIRE(sqlite3_step(stmt) == SQLITE_DONE);
        sqlite3_finalize(stmt);
    }

    HttpResponse PostValidate(const std::string& authHeader) {
        auto handler = net.FindPostHandlerForTest("/api/auth/validate");
        REQUIRE_MESSAGE(static_cast<bool>(handler),
                        "/api/auth/validate is not registered");
        HttpRequestHeaders headers;
        headers.authorization = authHeader;
        return handler("/api/auth/validate", "{}", headers);
    }
};

std::string Body(const HttpResponse& r) {
    return std::string(r.body.begin(), r.body.end());
}

}  // namespace

TEST_CASE("access TTL: one constant, and it is an hour") {
    // The definition moved to AuthTokens so the game server could share it;
    // HttpAuth's name survives as an alias for its own ~6 call sites. If the
    // two ever diverge again, the lobby and the game server disagree about
    // when a bearer token dies, which is unobservable from either side.
    static_assert(HttpAuth::kAccessTtlSeconds == AuthTokens::kAccessTtlSeconds,
                  "the access TTL must have exactly one definition");
    CHECK(AuthTokens::kAccessTtlSeconds == 60 * 60);
}

TEST_CASE("access TTL: ValidateSession's DEFAULT argument enforces it") {
    // This is the case the milestone exists for. The game server's
    // AuthRequest path called ValidateSession with no TTL argument, so the
    // default WAS the policy for every reconnect into every room — and it was
    // a literal 86400 that no note, plan row or grep for kAccessTtlSeconds
    // would ever have surfaced.
    AuthFixture f;
    const int64_t id = f.MakeUser("ttl_default");
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(f.db.CreateSession(id, token));
    CHECK(f.db.ValidateSession(token) == id);

    // Two hours: inside the old default, outside the new one.
    f.BackdateSession(token, 2 * 60 * 60);
    CHECK(f.db.ValidateSession(token) == 0);
    // ...and still refused when the caller names the constant, so the two
    // paths cannot disagree.
    CHECK(f.db.ValidateSession(token, AuthTokens::kAccessTtlSeconds) == 0);
}

TEST_CASE("SessionRemainingSeconds: a fresh session has ~the full TTL left") {
    AuthFixture f;
    const int64_t id = f.MakeUser("remaining_fresh");
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(f.db.CreateSession(id, token));

    const int64_t remaining = f.db.SessionRemainingSeconds(token);
    // Not an equality: `created_at` is second-resolution wall clock.
    CHECK(remaining > AuthTokens::kAccessTtlSeconds - 5);
    CHECK(remaining <= AuthTokens::kAccessTtlSeconds);
}

TEST_CASE("SessionRemainingSeconds: an aged session reports what is left, and 0 once dead") {
    AuthFixture f;
    const int64_t id = f.MakeUser("remaining_aged");
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(f.db.CreateSession(id, token));

    f.BackdateSession(token, 50 * 60);          // 50 min into a 60 min session
    const int64_t left = f.db.SessionRemainingSeconds(token);
    CHECK(left > 8 * 60);
    CHECK(left <= 10 * 60);

    // Never negative: a caller that adds this to `now` must not schedule a
    // renewal in the past, and the client treats 0 as "renew immediately".
    f.BackdateSession(token, 3 * 60 * 60);
    CHECK(f.db.SessionRemainingSeconds(token) == 0);
    CHECK(f.db.SessionRemainingSeconds("no-such-token") == 0);
}

TEST_CASE("/api/auth/validate reports expires_in, and it is the REMAINING life") {
    AuthFixture f;
    const int64_t id = f.MakeUser("validate_expires");
    const std::string token = HttpAuth::GenerateToken();
    REQUIRE(f.db.CreateSession(id, token));

    f.BackdateSession(token, 50 * 60);
    const HttpResponse resp = f.PostValidate("Bearer " + token);
    REQUIRE(resp.status == 200);
    const std::string body = Body(resp);
    REQUIRE(body.find("\"expires_in\":") != std::string::npos);

    const size_t at = body.find("\"expires_in\":") + 13;
    const int64_t reported = std::stoll(body.substr(at));
    // The whole point: NOT kAccessTtlSeconds. A client that armed its timer
    // against the full TTL here would renew half an hour after expiry.
    CHECK(reported < AuthTokens::kAccessTtlSeconds);
    CHECK(reported > 8 * 60);
    CHECK(reported <= 10 * 60);
}

TEST_CASE("/api/auth/validate omits expires_in for a Basic-auth caller") {
    // A Basic validate mints its session inside ValidateAuth and the header
    // carries no token to measure, so there is nothing honest to report. The
    // alternative — echoing the full TTL — would be a number about a session
    // the caller was never told the identity of.
    AuthFixture f;
    f.MakeUser("validate_basic");
    // base64("validate_basic:pw") — the tree ships a Base64 *decoder* only
    // (HttpAuth::Base64Decode, for exactly this header), so the literal is the
    // honest way to write it rather than adding an encoder for one test.
    const HttpResponse resp = f.PostValidate("Basic dmFsaWRhdGVfYmFzaWM6cHc=");
    REQUIRE(resp.status == 200);
    CHECK(Body(resp).find("\"expires_in\":") == std::string::npos);
}

TEST_CASE("guest mint and resume report the lifetime of the session they mint") {
    // Both routes handed out a session and said nothing about how long it was
    // good for, so guest.ts had no number to store — a guest was the one
    // account kind that could not schedule a renewal even in principle.
    AuthFixture f;
    auto guest = f.net.FindPostHandlerForTest("/api/auth/guest");
    REQUIRE_MESSAGE(static_cast<bool>(guest), "/api/auth/guest is not registered");
    HttpRequestHeaders headers;
    const HttpResponse minted = guest("/api/auth/guest", "{}", headers);
    REQUIRE(minted.status == 201);
    const std::string mintedBody = Body(minted);
    REQUIRE(mintedBody.find("\"expires_in\":" +
                            std::to_string(AuthTokens::kAccessTtlSeconds))
            != std::string::npos);

    // Resume, with the device token the mint handed back.
    const size_t dt = mintedBody.find("\"device_token\":\"");
    REQUIRE(dt != std::string::npos);
    const size_t start = dt + 16;
    const std::string deviceToken =
        mintedBody.substr(start, mintedBody.find('"', start) - start);

    auto resume = f.net.FindPostHandlerForTest("/api/auth/guest/resume");
    REQUIRE_MESSAGE(static_cast<bool>(resume),
                    "/api/auth/guest/resume is not registered");
    const HttpResponse resumed = resume(
        "/api/auth/guest/resume",
        "{\"device_token\":\"" + deviceToken + "\"}", headers);
    REQUIRE(resumed.status == 200);
    CHECK(Body(resumed).find("\"expires_in\":" +
                             std::to_string(AuthTokens::kAccessTtlSeconds))
          != std::string::npos);
}
