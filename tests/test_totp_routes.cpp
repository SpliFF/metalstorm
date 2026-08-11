#include <doctest/doctest.h>

#include "Server/Crypto.h"
#include "Server/Database.h"
#include "Server/HttpAuth.h"
#include "Server/NetworkServer.h"
#include "Server/Totp.h"

#include <string>
#include <unordered_map>

// PLAN-metalstorm-lobby.md §7.2, task 8d — the second factor where a player
// actually meets it: the login route and the enrolment routes, driven out of
// the real registration via NetworkServer::FindPostHandlerForTest (same
// vehicle as test_route_auth.cpp's D45 cases).
//
// test_totp.cpp proves the arithmetic and the table. These prove the WIRING,
// which is where a correct implementation still fails to protect anybody:
//
//  1. **A confirmed factor gates /api/auth/login.** The password alone must
//     stop being sufficient. This is the whole feature and it is one forgotten
//     branch away from being inert while every unit test still passes.
//  2. **Basic auth is not a bypass.** `Authorization: Basic <user:pass>` is
//     accepted on every TokenRequired route in the app and carries no code and
//     nowhere to put one. If it keeps working for an enrolled account, the
//     login gate is decoration — an attacker with the password never visits
//     /api/auth/login at all.
//  3. **A pending enrolment does not gate anything.** The lockout this
//     prevents is the one where opening the settings page and failing to scan
//     costs the player their account.
//  4. **Disabling costs both factors.** A stolen session must not be able to
//     strip 2FA, and neither must a stolen password.

namespace {

std::string BodyText(const HttpResponse& resp) {
    return std::string(resp.body.begin(), resp.body.end());
}

/// One registered POST route, invoked as the network layer would.
HttpResponse Post(NetworkServer& net, const std::string& path,
                  const std::string& body, const std::string& authHeader = "") {
    auto handler = net.FindPostHandlerForTest(path);
    REQUIRE_MESSAGE(static_cast<bool>(handler), (path + " is not registered").c_str());
    HttpRequestHeaders headers;
    headers.authorization = authHeader;
    return handler(path, body, headers);
}

/// A lobby with one ordinary account, and everything a test needs to act as it.
struct Fixture {
    Database db;
    NetworkServer net;
    const std::unordered_map<std::string, FactionData::FactionInfo> factions;
    int64_t     userId = 0;
    std::string token;
    std::string secret;

    static constexpr const char* kUser = "totpuser";
    static constexpr const char* kPass = "correct horse";

    Fixture() {
        REQUIRE(db.Open(":memory:"));
        HttpAuth::RegisterEndpoints(net, db, factions);
        userId = db.CreateUser(kUser, Crypto::HashPassword(kPass), "player",
                               /*isDev=*/false, "union");
        REQUIRE(userId != 0);
        token = HttpAuth::GenerateToken();
        REQUIRE(db.CreateSession(userId, token));
    }

    std::string bearer() const { return "Bearer " + token; }

    /// "Basic " + base64(user:pass) for this account, built by hand so the
    /// test does not depend on a helper the production path also uses.
    static std::string basicHeader(const std::string& user, const std::string& pass) {
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

    /// Take the account all the way to a live second factor, through the real
    /// routes — a fixture that wrote the rows directly would not notice the
    /// day enroll/confirm stop agreeing with each other.
    std::string enrolAndConfirm() {
        const HttpResponse enrol = Post(net, "/api/auth/totp/enroll", "{}", bearer());
        REQUIRE(enrol.status == 200);
        const std::string body = BodyText(enrol);
        const auto at = body.find("\"secret\":\"");
        REQUIRE(at != std::string::npos);
        const auto from = at + 10;
        secret = body.substr(from, body.find('"', from) - from);
        REQUIRE(secret.size() == 32);

        const std::string code = Totp::CodeForStep(secret, HttpAuth::NowUnix() / Totp::kStepSeconds);
        const HttpResponse confirm = Post(net, "/api/auth/totp/confirm",
                                          "{\"code\":\"" + code + "\"}", bearer());
        REQUIRE(confirm.status == 200);
        REQUIRE(Totp::IsEnabled(db.Handle(), userId));
        return BodyText(confirm);
    }

    /// A code for the step after whatever is already spent, so back-to-back
    /// calls inside one 30 s window do not trip the replay floor.
    std::string freshCode() {
        auto e = Totp::Load(db.Handle(), userId);
        REQUIRE(e.has_value());
        const int64_t now = HttpAuth::NowUnix() / Totp::kStepSeconds;
        const int64_t step = (e->lastStep >= now) ? e->lastStep + 1 : now;
        // A step beyond `now + 1` would fall outside the drift window, which
        // only happens if a test spends two codes in one window; +1 is inside.
        return Totp::CodeForStep(secret, step);
    }

    HttpResponse login(const std::string& extraJson = "") {
        std::string body = std::string("{\"username\":\"") + kUser +
                           "\",\"password\":\"" + kPass + "\"" + extraJson + "}";
        return Post(net, "/api/auth/login", body);
    }
};

}  // namespace

TEST_CASE("TOTP: login is unaffected until an enrolment is confirmed") {
    Fixture f;

    // No enrolment at all.
    CHECK(f.login().status == 200);

    // A PENDING enrolment must not gate login either. If it did, a player
    // whose phone failed to scan the secret would be locked out of their own
    // account by the act of opening the settings page.
    const HttpResponse enrol = Post(f.net, "/api/auth/totp/enroll", "{}", f.bearer());
    REQUIRE(enrol.status == 200);
    CHECK(BodyText(enrol).find("otpauth://totp/") != std::string::npos);
    CHECK(f.login().status == 200);
}

TEST_CASE("TOTP: a confirmed factor gates the password") {
    Fixture f;
    f.enrolAndConfirm();

    // Password alone: refused, and told WHY — the client has to know to ask
    // for a code, and the caller has already proved they hold the password.
    const HttpResponse noCode = f.login();
    CHECK(noCode.status == 401);
    CHECK(BodyText(noCode).find("\"totp_required\":true") != std::string::npos);
    CHECK(BodyText(noCode).find("\"token\"") == std::string::npos);

    // Wrong code: same refusal, no session.
    const HttpResponse bad = f.login(",\"totp_code\":\"000000\"");
    CHECK(bad.status == 401);
    CHECK(BodyText(bad).find("\"token\"") == std::string::npos);

    // Right code: through.
    const HttpResponse ok = f.login(",\"totp_code\":\"" + f.freshCode() + "\"");
    CHECK(ok.status == 200);
    CHECK(BodyText(ok).find("\"token\"") != std::string::npos);
}

TEST_CASE("TOTP: a login code cannot be replayed into a second session") {
    Fixture f;
    f.enrolAndConfirm();

    const std::string code = f.freshCode();
    const HttpResponse first = f.login(",\"totp_code\":\"" + code + "\"");
    REQUIRE(first.status == 200);

    // The same six digits, still inside their 30 s window. A code travels
    // through a form, a browser and a proxy; if the floor is not advanced by
    // the login route, an observed code opens a second session.
    const HttpResponse second = f.login(",\"totp_code\":\"" + code + "\"");
    CHECK(second.status == 401);
    CHECK(BodyText(second).find("\"token\"") == std::string::npos);
}

TEST_CASE("TOTP: Basic auth is not a way around the second factor") {
    Fixture f;
    const std::string basic = Fixture::basicHeader(Fixture::kUser, Fixture::kPass);

    // Before enrolment, Basic auth is exactly as it always was — this is the
    // control, and it is what makes the assertion below about the factor
    // rather than about a broken header.
    CHECK(HttpAuth::ValidateAuth(f.db, basic) == f.userId);

    f.enrolAndConfirm();

    // After: the password alone authenticates nothing, on any route in the
    // app. Without this the login gate is decoration — an attacker holding the
    // password simply never calls /api/auth/login.
    CHECK(HttpAuth::ValidateAuth(f.db, basic) == 0);
    // The session the player already holds is untouched: enrolling in 2FA is
    // not a logout.
    CHECK(HttpAuth::ValidateAuth(f.db, f.bearer()) == f.userId);
    // And an account with no factor is unaffected by the enrolled one's rows.
    const int64_t other = f.db.CreateUser("plainuser", Crypto::HashPassword("pw2"),
                                          "player", /*isDev=*/false, "compact");
    REQUIRE(other != 0);
    CHECK(HttpAuth::ValidateAuth(f.db, Fixture::basicHeader("plainuser", "pw2")) == other);
}

TEST_CASE("TOTP: recovery codes are minted at confirmation and spend once") {
    Fixture f;
    const std::string confirmBody = f.enrolAndConfirm();

    // The codes exist exactly once, in the confirmation response.
    CHECK(confirmBody.find("\"recovery_codes\":[\"") != std::string::npos);
    CHECK(Totp::RemainingRecoveryCodes(f.db.Handle(), f.userId) == Totp::kRecoveryCodes);

    const auto codes = Totp::IssueRecoveryCodes(f.db.Handle(), f.userId, 2,
                                                HttpAuth::NowUnix());
    REQUIRE(codes.size() == 2);

    // A recovery code is accepted wherever a TOTP code is — that is the point
    // of it; the player is holding paper, not a phone.
    const HttpResponse ok = f.login(",\"totp_code\":\"" + codes[0] + "\"");
    CHECK(ok.status == 200);
    // And it is spent. A replayable recovery code is a password that never
    // expires.
    CHECK(f.login(",\"totp_code\":\"" + codes[0] + "\"").status == 401);
    CHECK(Totp::RemainingRecoveryCodes(f.db.Handle(), f.userId) == 1);
}

TEST_CASE("TOTP: re-enrolling over a live factor is refused") {
    Fixture f;
    f.enrolAndConfirm();
    const std::string before = f.secret;

    const HttpResponse again = Post(f.net, "/api/auth/totp/enroll", "{}", f.bearer());
    CHECK(again.status == 409);
    // The live secret is untouched — a 409 that still rotated the secret would
    // be the lockout this check exists to prevent, reported as a refusal.
    CHECK(Totp::Load(f.db.Handle(), f.userId)->secret == before);
}

TEST_CASE("TOTP: disabling costs the password AND a code") {
    Fixture f;
    f.enrolAndConfirm();

    // A stolen session alone must not strip the factor: that is the exact
    // attack 2FA exists to stop.
    CHECK(Post(f.net, "/api/auth/totp/disable", "{}", f.bearer()).status == 401);
    CHECK(Totp::IsEnabled(f.db.Handle(), f.userId));

    // Nor the session plus a wrong password.
    CHECK(Post(f.net, "/api/auth/totp/disable",
               R"({"password":"wrong","code":"000000"})", f.bearer()).status == 401);
    CHECK(Totp::IsEnabled(f.db.Handle(), f.userId));

    // Nor the correct password on its own — the second factor assumes the
    // password is already compromised.
    CHECK(Post(f.net, "/api/auth/totp/disable",
               std::string("{\"password\":\"") + Fixture::kPass + "\"}",
               f.bearer()).status == 400);
    CHECK(Totp::IsEnabled(f.db.Handle(), f.userId));

    // Both together: off, and the recovery codes go with it.
    const HttpResponse off = Post(f.net, "/api/auth/totp/disable",
        std::string("{\"password\":\"") + Fixture::kPass +
        "\",\"code\":\"" + f.freshCode() + "\"}", f.bearer());
    CHECK(off.status == 200);
    CHECK_FALSE(Totp::IsEnabled(f.db.Handle(), f.userId));
    CHECK(Totp::RemainingRecoveryCodes(f.db.Handle(), f.userId) == 0);

    // And the password alone is a full login again.
    CHECK(f.login().status == 200);
    CHECK(HttpAuth::ValidateAuth(f.db, Fixture::basicHeader(Fixture::kUser,
                                                            Fixture::kPass)) == f.userId);
}

TEST_CASE("TOTP: abandoning a pending enrolment is free") {
    Fixture f;
    REQUIRE(Post(f.net, "/api/auth/totp/enroll", "{}", f.bearer()).status == 200);

    // No password, no code: a never-confirmed enrolment protects nothing, and
    // demanding a code from a secret the player could not scan is the trap.
    const HttpResponse off = Post(f.net, "/api/auth/totp/disable", "{}", f.bearer());
    CHECK(off.status == 200);
    CHECK_FALSE(Totp::Load(f.db.Handle(), f.userId).has_value());
}

TEST_CASE("TOTP: status and validate report the factor's state") {
    Fixture f;

    auto statusBody = [&] {
        const HttpResponse r = Post(f.net, "/api/auth/totp/status", "{}", f.bearer());
        CHECK(r.status == 200);
        return BodyText(r);
    };
    CHECK(statusBody().find("\"enabled\":false") != std::string::npos);
    CHECK(statusBody().find("\"pending\":false") != std::string::npos);

    REQUIRE(Post(f.net, "/api/auth/totp/enroll", "{}", f.bearer()).status == 200);
    CHECK(statusBody().find("\"pending\":true") != std::string::npos);
    CHECK(statusBody().find("\"enabled\":false") != std::string::npos);

    f.enrolAndConfirm();
    CHECK(statusBody().find("\"enabled\":true") != std::string::npos);
    CHECK(statusBody().find("\"recovery_remaining\":10") != std::string::npos);

    // /api/auth/validate is the path a returning browser always takes, so it
    // carries the flag too — otherwise a settings screen renders "2FA: off"
    // for a moment on every load of an account that has it on.
    const HttpResponse v = Post(f.net, "/api/auth/validate", "{}", f.bearer());
    CHECK(v.status == 200);
    CHECK(BodyText(v).find("\"totp_enabled\":true") != std::string::npos);
}

TEST_CASE("TOTP: enrolment and disable are unauthenticated-proof") {
    Fixture f;
    for (const char* path : {"/api/auth/totp/enroll", "/api/auth/totp/confirm",
                             "/api/auth/totp/disable", "/api/auth/totp/status"}) {
        CHECK(Post(f.net, path, "{}", "Bearer nonsense").status == 401);
        CHECK(Post(f.net, path, "{}", "").status == 401);
    }
    // All four are TokenRequired, so the dispatcher would reject an anonymous
    // caller before the handler ran — but the handlers do not rely on that,
    // because a route tag is a line somebody can change.
    int tagged = 0;
    for (auto& r : f.net.GetRegisteredRoutes()) {
        if (r.pattern.rfind("/api/auth/totp/", 0) == 0) {
            ++tagged;
            CHECK(r.auth == RouteAuth::TokenRequired);
        }
    }
    CHECK(tagged == 4);
}
