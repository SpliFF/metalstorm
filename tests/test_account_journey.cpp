#include <doctest/doctest.h>

#include "Server/Database.h"
#include "Server/GuestAccounts.h"
#include "Server/HttpAuth.h"
#include "Server/Mentorship.h"
#include "Server/NetworkServer.h"
#include "Server/Standing.h"

#include <string>
#include <unordered_map>

// PLAN-beta-journey.md §(a)/§(b), lane A1 — one spec per new mechanism.
//
// The three claims worth a test are the ones that can each be false while
// everything around them is correct:
//
//  1. **One nickname rule.** The mint and the upgrade share ValidNickname, so
//     a name accepted at the door cannot be refused at the upgrade — which
//     would strand a player under a name they had been playing under.
//  2. **Guest nicknames share the users.username namespace.** The 409 is what
//     stops a guest spectating a war under the exact name a registered player
//     fights it under. A second uniqueness domain passes every unit test of
//     the rule and opens exactly that.
//  3. **Tier is derived, never stored.** The thresholds are expected to move
//     during beta; a stored tier would need a backfill and a derived one does
//     not.

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

std::string Field(const std::string& body, const std::string& key) {
    const std::string needle = "\"" + key + "\":\"";
    const auto at = body.find(needle);
    if (at == std::string::npos) return "";
    const auto from = at + needle.size();
    return body.substr(from, body.find('"', from) - from);
}

struct Fixture {
    Database db;
    NetworkServer net;
    std::unordered_map<std::string, FactionData::FactionInfo> factions;

    Fixture() {
        REQUIRE(db.Open(":memory:"));
        factions["union"];
        HttpAuth::RegisterEndpoints(net, db, factions);
        HttpAuth::RegisterAccountRoutes(net, db);
    }
};

}  // namespace

TEST_CASE("GuestAccounts::ValidNickname is the one nickname rule") {
    CHECK(GuestAccounts::ValidNickname("raven"));
    CHECK(GuestAccounts::ValidNickname("Kx"));                 // 2 is the floor
    CHECK(GuestAccounts::ValidNickname(std::string(32, 'a')));  // 32 is the ceiling
    CHECK(GuestAccounts::ValidNickname("a_b-C9"));

    CHECK_FALSE(GuestAccounts::ValidNickname("x"));
    CHECK_FALSE(GuestAccounts::ValidNickname(std::string(33, 'a')));
    CHECK_FALSE(GuestAccounts::ValidNickname(""));
    CHECK_FALSE(GuestAccounts::ValidNickname("has space"));
    CHECK_FALSE(GuestAccounts::ValidNickname("dot.name"));
    // The reserved shape: claiming it impersonates a generated guest and can
    // collide with one the lobby is about to mint.
    CHECK_FALSE(GuestAccounts::ValidNickname("guest-abcd1234"));

    // The same predicate decides the upgrade — if these ever diverge, a guest
    // is refused the name they signed in under.
    GuestAccounts::AccountState before;
    before.id = 1;
    before.username = "guest-dead";
    before.isProvisional = true;
    before.factionId = "union";
    for (const char* name : {"guest-beef", "n", "bad name"}) {
        GuestAccounts::UpgradeRequest req;
        req.username = name;
        req.password = "correcthorse";
        const auto plan = GuestAccounts::DecideUpgrade(req, before, true, false, false);
        CHECK(plan.status == GuestAccounts::UpgradeStatus::BadUsername);
    }
}

TEST_CASE("a guest may choose a nickname, and the second claim on it is a 409") {
    Fixture f;

    HttpResponse r = Post(f.net, "/api/auth/guest", R"({"username":"raven","faction":"union"})");
    CHECK(r.status == 201);
    std::string body = BodyText(r);
    CHECK(Field(body, "username") == "raven");
    CHECK(body.find("\"nickname_chosen\":true") != std::string::npos);

    // Second claim — same `users.username` namespace as a registered
    // account, so it is refused. D6: the holder here is ANOTHER GUEST, who
    // cannot be logged into (no password), so this must NOT be name_taken —
    // that message's implied remedy ("log in as them") is impossible for a
    // passwordless guest. It gets its own key instead.
    r = Post(f.net, "/api/auth/guest", R"({"username":"raven"})");
    CHECK(r.status == 409);
    body = BodyText(r);
    CHECK(body.find("\"name_in_use_guest\":true") != std::string::npos);
    CHECK(body.find("\"name_taken\":true") == std::string::npos);

    // A bad nickname is refused before an account is minted at all.
    CHECK(Post(f.net, "/api/auth/guest", R"({"username":"guest-ff00"})").status == 400);
    CHECK_FALSE(f.db.FindUser("guest-ff00").has_value());

    // No nickname is still the generated-hex guest, and says so.
    r = Post(f.net, "/api/auth/guest", "{}");
    CHECK(r.status == 201);
    body = BodyText(r);
    CHECK(Field(body, "username").rfind("guest-", 0) == 0);
    CHECK(body.find("\"nickname_chosen\":false") != std::string::npos);
}

TEST_CASE("D6: a guest name held by a REGISTERED player still says name_taken") {
    Fixture f;

    // A real, password-holding account claims "falcon" via sign-up.
    const HttpResponse reg = Post(f.net, "/api/auth/register",
        R"({"username":"falcon","password":"correcthorsebattery","faction":"union"})");
    REQUIRE(reg.status == 201);

    // A guest mint under the same name collides with a holder that CAN be
    // logged into — the original message and key are correct here, and must
    // stay distinct from the guest-holder case above.
    const HttpResponse r = Post(f.net, "/api/auth/guest", R"({"username":"falcon"})");
    CHECK(r.status == 409);
    const std::string body = BodyText(r);
    CHECK(body.find("\"name_taken\":true") != std::string::npos);
    CHECK(body.find("\"name_in_use_guest\":true") == std::string::npos);
}

TEST_CASE("Standing::TierFor derives the tier from the one stored number") {
    CHECK(Standing::TierFor(0) == 0);
    CHECK(Standing::TierFor(19) == 0);
    CHECK(Standing::TierFor(20) == 1);
    CHECK(Standing::TierFor(59) == 1);
    CHECK(Standing::TierFor(60) == 2);
    CHECK(Standing::TierFor(149) == 2);
    CHECK(Standing::TierFor(150) == 3);
    CHECK(Standing::TierFor(399) == 3);
    CHECK(Standing::TierFor(400) == 4);
    CHECK(Standing::TierFor(99999) == 4);
    // Clamped rather than rejected: this is read on every roster build and
    // must not have a failure mode.
    CHECK(Standing::TierFor(-5) == 0);

    CHECK(std::string(Standing::TierName(0)) == "Recruit");
    CHECK(std::string(Standing::TierName(4)) == "Commander");
    CHECK(std::string(Standing::TierName(99)) == "Recruit");

    CHECK(Standing::ToNextTier(0) == 20);
    CHECK(Standing::ToNextTier(400) == 0);
}

TEST_CASE("/api/account/me reports a fresh account as a Recruit, and profile writes are partial") {
    Fixture f;
    const HttpResponse guest =
        Post(f.net, "/api/auth/guest", R"({"username":"raven","faction":"union"})");
    REQUIRE(guest.status == 201);
    const std::string token = Field(BodyText(guest), "token");
    const std::string auth = "Bearer " + token;

    std::string me = BodyText(Post(f.net, "/api/account/me", "{}", auth));
    CHECK(me.find("\"standing\":0") != std::string::npos);
    CHECK(me.find("\"tier\":0") != std::string::npos);
    CHECK(Field(me, "tier_name") == "Recruit");
    // Never null: an account that never chose one IS its username.
    CHECK(Field(me, "callsign") == "raven");
    CHECK(me.find("\"commander_kind\":null") != std::string::npos);
    CHECK(me.find("\"intro_done\":false") != std::string::npos);
    CHECK(me.find("\"mentorship\":null") != std::string::npos);

    CHECK(Post(f.net, "/api/account/me", "{}", "Bearer nope").status == 401);

    // Skip sends intro_done alone and must not blank the other two.
    CHECK(Post(f.net, "/api/account/profile",
               R"({"callsign":"Nightjar","commander_kind":"signals"})", auth).status == 200);
    CHECK(Post(f.net, "/api/account/profile", R"({"intro_done":true})", auth).status == 200);
    me = BodyText(Post(f.net, "/api/account/me", "{}", auth));
    CHECK(Field(me, "callsign") == "Nightjar");
    CHECK(Field(me, "commander_kind") == "signals");
    CHECK(me.find("\"intro_done\":true") != std::string::npos);

    CHECK(Post(f.net, "/api/account/profile", R"({"commander_kind":"wizard"})", auth).status == 400);
    CHECK(Post(f.net, "/api/account/profile", R"({"callsign":"guest-0000"})", auth).status == 400);
    CHECK(Post(f.net, "/api/account/profile", "{}", auth).status == 400);

    // Standing accrues relatively, and the tier follows it with nothing else
    // written anywhere.
    auto row = f.db.FindUser("raven");
    REQUIRE(row.has_value());
    CHECK(f.db.AddStanding(row->id, 20, 1));
    me = BodyText(Post(f.net, "/api/account/me", "{}", auth));
    CHECK(me.find("\"tier\":1") != std::string::npos);
    CHECK(Field(me, "tier_name") == "Regular");
    CHECK(me.find("\"sessions_played\":1") != std::string::npos);
}

TEST_CASE("one live mentorship per mentee, and one endorsement per pair per day") {
    Fixture f;
    Mentorship::EnsureTables(f.db.Handle());
    const int64_t mentee = f.db.CreateUser("recruit", "h");
    const int64_t mentor = f.db.CreateUser("veteran", "h");
    const int64_t other  = f.db.CreateUser("bystander", "h");
    REQUIRE(mentee > 0);

    auto offer = Mentorship::Offer(f.db.Handle(), mentor, mentee, 1000);
    CHECK(offer.status == Mentorship::Status::OK);
    // Offered counts as live: a second offer would leave two people issuing
    // orders that the rank-precedence rule cannot arbitrate between.
    CHECK(Mentorship::Offer(f.db.Handle(), other, mentee, 1001).status ==
          Mentorship::Status::AlreadyMentored);
    CHECK(Mentorship::Offer(f.db.Handle(), mentee, mentee, 1001).status ==
          Mentorship::Status::SelfMentor);

    // Only the mentee answers it.
    CHECK(Mentorship::Respond(f.db.Handle(), offer.id, other, true, 1002) ==
          Mentorship::Status::NotYours);
    CHECK(Mentorship::Respond(f.db.Handle(), offer.id, mentee, true, 1002) ==
          Mentorship::Status::OK);
    auto live = Mentorship::ActiveFor(f.db.Handle(), mentee);
    REQUIRE(live.has_value());
    CHECK(live->state == "active");
    CHECK(live->kind == "human");

    // Declining ends the row rather than leaving it live, so the next offer
    // can be made — "declining keeps independence", not "declining locks out".
    CHECK(Mentorship::End(f.db.Handle(), mentee, mentor, 1003) == Mentorship::Status::OK);
    auto declined = Mentorship::Offer(f.db.Handle(), mentor, mentee, 1004);
    REQUIRE(declined.status == Mentorship::Status::OK);
    CHECK(Mentorship::Respond(f.db.Handle(), declined.id, mentee, false, 1005) ==
          Mentorship::Status::OK);
    CHECK_FALSE(Mentorship::ActiveFor(f.db.Handle(), mentee).has_value());

    // The AI fallback is active on arrival — the mentee asking IS the answer.
    auto ai = Mentorship::Offer(f.db.Handle(), Mentorship::kAiMentorId, mentee, 1006);
    REQUIRE(ai.status == Mentorship::Status::OK);
    live = Mentorship::ActiveFor(f.db.Handle(), mentee);
    REQUIRE(live.has_value());
    CHECK(live->state == "active");
    CHECK(live->kind == "ai");

    // The endorsement rate limit is the whole cap on +15 standing.
    const int64_t day = Mentorship::kEndorsementDaySeconds;
    CHECK(Mentorship::Endorse(f.db.Handle(), mentor, mentee, 5 * day + 10));
    CHECK_FALSE(Mentorship::Endorse(f.db.Handle(), mentor, mentee, 5 * day + 900));
    CHECK(Mentorship::Endorse(f.db.Handle(), mentor, mentee, 6 * day + 10));
}
