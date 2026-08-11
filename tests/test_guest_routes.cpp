#include <doctest/doctest.h>

#include "Server/AuthTokens.h"
#include "Server/Crypto.h"
#include "Server/Database.h"
#include "Server/GuestAccounts.h"
#include "Server/HttpAuth.h"
#include "Server/NetworkServer.h"
#include "Server/WarPlayerBindings.h"

#include <string>
#include <unordered_map>

// PLAN-metalstorm-lobby.md §7.1, task 8c — guests where a player meets them,
// driven out of the real route registration via
// NetworkServer::FindPostHandlerForTest (same vehicle as test_totp_routes.cpp).
//
// test_guest_accounts.cpp proves the rules. These prove the claims the feature
// is sold on, each of which can be false while every rule below it is correct:
//
//  1. **The upgrade does not move the account.** The user id is the same
//     afterwards, so everything keyed on it — war bindings and their saved
//     per-player state, reconnect tokens, presets — is still there. A
//     migration-shaped implementation passes every unit test and loses the
//     war seat, which is the entire point of the feature.
//  2. **A guest cannot be logged into.** The password hash is stored EMPTY
//     rather than as a sentinel, because Crypto::VerifyPassword compares any
//     non-scrypt stored value as legacy plaintext — a sentinel would be a
//     working password for every guest in the deployment. Both doors are
//     checked: /api/auth/login and Basic auth.
//  3. **The device token is spent by the upgrade.** A live device token left
//     behind is a password-free session on what is now a real account.
//  4. **A guest is not seeding population.** `POST /api/auth/guest` is the one
//     route that mints an account with nothing presented, so counting guests
//     would let a script size every new war's sides against nobody.

namespace {

std::string BodyText(const HttpResponse& resp) {
    return std::string(resp.body.begin(), resp.body.end());
}

HttpResponse Post(NetworkServer& net, const std::string& path,
                  const std::string& body, const std::string& authHeader = "") {
    auto handler = net.FindPostHandlerForTest(path);
    REQUIRE_MESSAGE(static_cast<bool>(handler), (path + " is not registered").c_str());
    HttpRequestHeaders headers;
    headers.authorization = authHeader;
    return handler(path, body, headers);
}

/// Pull a flat string field out of a response body. Deliberately not
/// HttpAuth::JsonField — a test that parses with the code under test cannot
/// see the day the code stops emitting the field at all.
std::string Field(const std::string& body, const std::string& key) {
    const std::string needle = "\"" + key + "\":\"";
    const auto at = body.find(needle);
    if (at == std::string::npos) return "";
    const auto from = at + needle.size();
    return body.substr(from, body.find('"', from) - from);
}

bool HasFlag(const std::string& body, const std::string& key, bool value) {
    return body.find("\"" + key + "\":" + (value ? "true" : "false"))
           != std::string::npos;
}

std::string BasicHeader(const std::string& user, const std::string& pass) {
    static const char* kB64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const std::string in = user + ":" + pass;
    std::string out;
    for (size_t i = 0; i < in.size(); i += 3) {
        const unsigned a = static_cast<unsigned char>(in[i]);
        const unsigned b = i + 1 < in.size() ? static_cast<unsigned char>(in[i + 1]) : 0;
        const unsigned c = i + 2 < in.size() ? static_cast<unsigned char>(in[i + 2]) : 0;
        const unsigned triple = (a << 16) | (b << 8) | c;
        out += kB64[(triple >> 18) & 0x3F];
        out += kB64[(triple >> 12) & 0x3F];
        out += (i + 1 < in.size()) ? kB64[(triple >> 6) & 0x3F] : '=';
        out += (i + 2 < in.size()) ? kB64[triple & 0x3F] : '=';
    }
    return "Basic " + out;
}

std::unordered_map<std::string, FactionData::FactionInfo> TwoFactions() {
    std::unordered_map<std::string, FactionData::FactionInfo> m;
    m["union"];
    m["compact"];
    return m;
}

/// A lobby with the real routes registered and two declared factions.
struct Fixture {
    Database db;
    NetworkServer net;
    const std::unordered_map<std::string, FactionData::FactionInfo> factions = TwoFactions();

    Fixture() {
        REQUIRE(db.Open(":memory:"));
        HttpAuth::RegisterEndpoints(net, db, factions);
    }

    /// Sign in as a guest through the real route. Returns the parsed response.
    struct Guest {
        int64_t     userId = 0;
        std::string username;
        std::string token;
        std::string device;
    };
    Guest signIn(const char* faction = "union") {
        const std::string body =
            faction ? std::string("{\"faction\":\"") + faction + "\"}" : "{}";
        const HttpResponse r = Post(net, "/api/auth/guest", body);
        REQUIRE(r.status == 201);
        const std::string b = BodyText(r);
        Guest g;
        g.username = Field(b, "username");
        g.token    = Field(b, "token");
        g.device   = Field(b, "device_token");
        auto row = db.FindUser(g.username);
        REQUIRE(row.has_value());
        g.userId = row->id;
        return g;
    }
};

}  // namespace

TEST_CASE("a guest sign-in mints a provisional account, a session and a device token") {
    Fixture f;
    const auto g = f.signIn("union");
    CHECK(g.username.rfind("guest-", 0) == 0);
    CHECK(g.token.size() == 32);
    CHECK(g.device.size() == 64);

    auto row = f.db.FindUserById(g.userId);
    REQUIRE(row.has_value());
    CHECK(row->isProvisional);
    CHECK(row->factionId.value_or("") == "union");
    // The empty hash is the security property, not an omission — see the
    // header note and the two refusal cases below.
    CHECK(row->passwordHash.empty());
    // The session works like any other.
    CHECK(f.db.ValidateSession(g.token) == g.userId);
}

TEST_CASE("a factionless guest is allowed — that is the spectator shape") {
    Fixture f;
    const auto g = f.signIn(nullptr);
    auto row = f.db.FindUserById(g.userId);
    REQUIRE(row.has_value());
    CHECK(row->isProvisional);
    CHECK_FALSE(row->factionId.has_value());
}

TEST_CASE("a guest sign-in refuses a faction the game does not declare") {
    Fixture f;
    const HttpResponse r = Post(f.net, "/api/auth/guest", R"({"faction":"aliens"})");
    CHECK(r.status == 400);
}

TEST_CASE("a guest cannot be logged into — neither by password nor by Basic") {
    Fixture f;
    const auto g = f.signIn();

    // The empty stored hash refuses every candidate. The failure this pins is
    // a sentinel value ("!guest") being compared as legacy plaintext, which
    // would make one string the password for every guest account in the
    // deployment.
    for (const char* attempt : {"!guest", "guest", "provisional", "password"}) {
        const std::string body = "{\"username\":\"" + g.username +
                                 "\",\"password\":\"" + attempt + "\"}";
        const HttpResponse r = Post(f.net, "/api/auth/login", body);
        CHECK(r.status == 401);
    }
    // The empty password is refused one step earlier, by the missing-field
    // guard — asserted as its own code rather than folded into the 401s above,
    // because "refused for a different reason" is worth seeing move.
    CHECK(Post(f.net, "/api/auth/login",
               "{\"username\":\"" + g.username + "\",\"password\":\"\"}").status == 400);
    // Basic auth is the other door, and it is the one an attacker who never
    // visits the login route uses (task 8d's finding).
    const HttpResponse validate = Post(f.net, "/api/auth/validate", "{}",
                                       BasicHeader(g.username, ""));
    CHECK(validate.status == 401);
}

TEST_CASE("resume trades the device token for a fresh session") {
    Fixture f;
    const auto g = f.signIn();
    const HttpResponse r = Post(f.net, "/api/auth/guest/resume",
                                "{\"device_token\":\"" + g.device + "\"}");
    REQUIRE(r.status == 200);
    const std::string b = BodyText(r);
    const std::string fresh = Field(b, "token");
    CHECK(fresh != g.token);
    CHECK(f.db.ValidateSession(fresh) == g.userId);
    CHECK(Field(b, "username") == g.username);
    CHECK(HasFlag(b, "provisional", true));
    // No refresh token: the device token already IS the long-lived credential.
    CHECK(b.find("refresh_token") == std::string::npos);
}

TEST_CASE("resume refuses an unknown device token") {
    Fixture f;
    f.signIn();
    CHECK(Post(f.net, "/api/auth/guest/resume",
               R"({"device_token":"0000000000000000"})").status == 401);
    CHECK(Post(f.net, "/api/auth/guest/resume", "{}").status == 400);
}

TEST_CASE("the upgrade keeps the account id, and everything keyed on it") {
    Fixture f;
    const auto g = f.signIn("union");

    // Give the guest something durable to lose: a war seat with saved
    // per-player state (task 4), which is what "progress" means here.
    WarPlayerBindings::EnsureTable(f.db.Handle());
    REQUIRE(WarPlayerBindings::BindSeat(f.db.Handle(), 7, g.userId, g.username,
                                        "union", /*team=*/1, 1'700'000'000));
    WarPlayerState state;
    state.authorityPool = 100.0;
    REQUIRE(WarPlayerBindings::SaveState(f.db.Handle(), 7, g.userId, state,
                                         1'700'000'000));

    const HttpResponse r = Post(f.net, "/api/auth/upgrade",
        R"({"username":"Ravager","password":"hunter22hunter"})",
        "Bearer " + g.token);
    REQUIRE(r.status == 200);
    const std::string b = BodyText(r);
    CHECK(Field(b, "username") == "Ravager");
    CHECK(Field(b, "faction") == "union");
    CHECK(HasFlag(b, "provisional", false));
    CHECK(b.find("\"cleared_bindings\":0") != std::string::npos);

    // Same row, renamed and no longer provisional.
    auto row = f.db.FindUserById(g.userId);
    REQUIRE(row.has_value());
    CHECK(row->username == "Ravager");
    CHECK_FALSE(row->isProvisional);
    CHECK_FALSE(row->passwordHash.empty());
    CHECK_FALSE(f.db.FindUser(g.username).has_value());  // the guest name is gone

    // And the seat — with its state — came with it, because nothing moved.
    auto binding = WarPlayerBindings::Find(f.db.Handle(), 7, g.userId);
    REQUIRE(binding.has_value());
    CHECK(binding->team == 1);
    CHECK(binding->HasSavedState());
    CHECK(binding->state.authorityPool == doctest::Approx(100.0));
    // The binding's denormalised name copy moved with the rename. Found live:
    // every functional reader keys on account_id, so this is cosmetic today —
    // but nothing maintained it, because until this route no path in the
    // system could rename an account at all.
    CHECK(binding->username == "Ravager");

    // The new password is the account's credential now.
    const HttpResponse login = Post(f.net, "/api/auth/login",
        R"({"username":"Ravager","password":"hunter22hunter"})");
    CHECK(login.status == 200);
}

TEST_CASE("the upgrade spends the device token") {
    Fixture f;
    const auto g = f.signIn();
    REQUIRE(Post(f.net, "/api/auth/upgrade",
                 R"({"password":"hunter22hunter"})",
                 "Bearer " + g.token).status == 200);
    // Left live, this is a password-free session on a real account.
    CHECK(Post(f.net, "/api/auth/guest/resume",
               "{\"device_token\":\"" + g.device + "\"}").status == 401);
}

TEST_CASE("an upgrade that switches faction clears the seats — §1b inherited") {
    Fixture f;
    const auto g = f.signIn("union");
    WarPlayerBindings::EnsureTable(f.db.Handle());
    REQUIRE(WarPlayerBindings::BindSeat(f.db.Handle(), 7, g.userId, g.username,
                                        "union", 1, 1'700'000'000));
    REQUIRE(AuthTokens::IssueWarReconnect(f.db.Handle(), g.userId, 7,
                                          AuthTokens::kWarReconnectTtlSeconds,
                                          1'700'000'000).has_value());

    const HttpResponse r = Post(f.net, "/api/auth/upgrade",
        R"({"password":"hunter22hunter","faction":"compact"})",
        "Bearer " + g.token);
    REQUIRE(r.status == 200);
    const std::string b = BodyText(r);
    CHECK(Field(b, "faction") == "compact");
    CHECK(b.find("\"cleared_bindings\":1") != std::string::npos);
    CHECK(b.find("\"cleared_war_tokens\":1") != std::string::npos);
    // The seat on the abandoned side is gone, and so is the credential that
    // would have re-seated the account on it.
    CHECK_FALSE(WarPlayerBindings::Find(f.db.Handle(), 7, g.userId).has_value());
}

TEST_CASE("upgrading twice is a conflict, not a password reset") {
    Fixture f;
    const auto g = f.signIn();
    const std::string bearer = "Bearer " + g.token;
    REQUIRE(Post(f.net, "/api/auth/upgrade",
                 R"({"password":"hunter22hunter"})", bearer).status == 200);
    // The session survives the upgrade (the player is not logged out), so this
    // is a reachable call — and it must not be an unauthenticated password
    // change on a full account.
    const HttpResponse again = Post(f.net, "/api/auth/upgrade",
        R"({"password":"somethingelse99"})", bearer);
    CHECK(again.status == 409);
    // The first password still works.
    CHECK(Post(f.net, "/api/auth/login",
               "{\"username\":\"" + g.username +
               "\",\"password\":\"hunter22hunter\"}").status == 200);
}

TEST_CASE("the upgrade refuses a name somebody else holds") {
    Fixture f;
    REQUIRE(f.db.CreateUser("Ravager", Crypto::HashPassword("x"), "player",
                            false, "compact") != 0);
    const auto g = f.signIn();
    const HttpResponse r = Post(f.net, "/api/auth/upgrade",
        R"({"username":"Ravager","password":"hunter22hunter"})",
        "Bearer " + g.token);
    CHECK(r.status == 409);
    // Nothing was written — a refused rename must not leave the password
    // installed under the guest name.
    auto row = f.db.FindUserById(g.userId);
    REQUIRE(row.has_value());
    CHECK(row->isProvisional);
    CHECK(row->passwordHash.empty());
}

TEST_CASE("a guest cannot enrol a second factor, and can the moment it claims") {
    // Not tidiness — a one-way door. Turning 2FA off costs the password as
    // well as a code (task 8d, deliberately), and a guest has no password, so
    // an enrolled guest would hold a factor nothing can remove. It would also
    // gate nothing: a guest signs in through `guest/resume`, which never
    // visits the login route the factor guards.
    Fixture f;
    const auto g = f.signIn();
    const HttpResponse blocked = Post(f.net, "/api/auth/totp/enroll", "{}",
                                      "Bearer " + g.token);
    CHECK(blocked.status == 409);

    // The matched control: the same account, the same session, one upgrade
    // later.
    REQUIRE(Post(f.net, "/api/auth/upgrade",
                 R"({"password":"hunter22hunter"})",
                 "Bearer " + g.token).status == 200);
    const HttpResponse allowed = Post(f.net, "/api/auth/totp/enroll", "{}",
                                      "Bearer " + g.token);
    CHECK(allowed.status == 200);
}

TEST_CASE("the upgrade needs a token of its own") {
    Fixture f;
    f.signIn();
    CHECK(Post(f.net, "/api/auth/upgrade",
               R"({"password":"hunter22hunter"})").status == 401);
}

TEST_CASE("guests are not war-seeding population until they upgrade") {
    Fixture f;
    REQUIRE(f.db.CreateUser("realplayer", Crypto::HashPassword("x"), "player",
                            false, "union") != 0);
    const auto g = f.signIn("union");

    // Two accounts hold "union"; one of them is a guest.
    auto counts = f.db.CountAccountsByFaction();
    CHECK(counts["union"] == 1u);

    REQUIRE(Post(f.net, "/api/auth/upgrade",
                 R"({"password":"hunter22hunter"})",
                 "Bearer " + g.token).status == 200);
    // Joining the count is exactly what upgrading means for §6's sizing.
    counts = f.db.CountAccountsByFaction();
    CHECK(counts["union"] == 2u);
}
