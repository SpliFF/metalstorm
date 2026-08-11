#include <doctest/doctest.h>

#include <sqlite3.h>

#include <cctype>
#include <set>
#include <string>

#include "Server/Totp.h"

// PLAN-metalstorm-lobby.md §7.2, task 8d — the optional second factor.
//
// What these tests pin down, and why each is a thing that can silently be
// wrong rather than a restatement of the code:
//
//  1. **The arithmetic is RFC 6238, not our own.** A TOTP implementation that
//     is self-consistent but not RFC-conformant passes every round-trip test
//     anyone would write and fails against every authenticator app on a
//     player's phone — and it fails at enrolment, where the player concludes
//     the feature is broken and we conclude they typed it wrong. So the codes
//     are checked against the published RFC 6238 Appendix B vectors, which is
//     the only assertion here that can catch a wrong-but-consistent HMAC,
//     truncation or counter encoding.
//  2. **A code cannot be spent twice.** A six-digit code is valid for a whole
//     30-second window and travels through a form, a browser and a proxy. If
//     the replay floor is not advanced, a code observed once opens a second
//     session inside its window — and nothing about the system looks wrong.
//  3. **Enrolment is not live until it is proven.** The unconfirmed state is
//     the difference between "you have 2FA" and "you are locked out of your
//     account because you visited the settings page and your phone did not
//     scan". Only Confirm may set it live.
//  4. **A recovery code is single-use and hashed at rest.** These are
//     password-equivalent and long-lived; a replayable one is a permanent
//     credential, and a plaintext one turns a db read into an account.
//  5. **The drift window is bounded.** Accepting a code from two minutes ago
//     is a quiet multiplication of an attacker's guessing surface, and it is
//     the kind of constant that gets widened to "fix" a clock complaint.

namespace {

struct TestDb {
    sqlite3* db = nullptr;
    TestDb() {
        REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
        Totp::EnsureTables(db);
    }
    ~TestDb() { sqlite3_close(db); }
};

constexpr int64_t kUser = 7;
/// A fixed, arbitrary secret for the storage tests (base32 of "12345678901234567890",
/// the RFC's own key — reused here purely because it is a known-good decode).
const std::string kSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/// Does `needle` appear anywhere in `table`? Used to prove the raw recovery
/// code is not stored — a column-by-column check would miss the day somebody
/// adds a "label" column holding the display form.
bool AppearsInTable(sqlite3* db, const char* table, const std::string& needle) {
    std::string sql = "SELECT * FROM ";
    sql += table;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK)
        return false;
    bool found = false;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        for (int i = 0; i < sqlite3_column_count(stmt); ++i) {
            if (const unsigned char* t = sqlite3_column_text(stmt, i)) {
                if (std::string(reinterpret_cast<const char*>(t)).find(needle)
                    != std::string::npos)
                    found = true;
            }
        }
    }
    sqlite3_finalize(stmt);
    return found;
}

}  // namespace

TEST_CASE("Totp: base32 round-trips and rejects out-of-alphabet input") {
    // RFC 4648 §10 test vectors — the encoder is checked against the standard
    // rather than against its own decoder, because a pair of matching bugs
    // round-trips perfectly and still hands the authenticator a wrong secret.
    CHECK(Totp::Base32Encode("f")      == "MY");
    CHECK(Totp::Base32Encode("fo")     == "MZXQ");
    CHECK(Totp::Base32Encode("foo")    == "MZXW6");
    CHECK(Totp::Base32Encode("foob")   == "MZXW6YQ");
    CHECK(Totp::Base32Encode("fooba")  == "MZXW6YTB");
    CHECK(Totp::Base32Encode("foobar") == "MZXW6YTBOI");

    CHECK(Totp::Base32Decode("MZXW6YTBOI") == "foobar");
    // Padding, lowercase and the separators a display format introduces all
    // survive, because a player types the secret back by hand.
    CHECK(Totp::Base32Decode("mzxw6ytboi") == "foobar");
    CHECK(Totp::Base32Decode("MZXW 6YTB OI") == "foobar");
    CHECK(Totp::Base32Decode("MZXW6YTBOI======") == "foobar");

    // A character outside the alphabet fails the whole decode. Skipping it
    // would turn a typo'd secret into a different VALID secret, whose codes
    // simply never match — with no error anywhere to explain why.
    CHECK(Totp::Base32Decode("MZXW6YTB01").empty());
    CHECK(Totp::Base32Decode("!!!").empty());
}

TEST_CASE("Totp: codes match the RFC 6238 Appendix B vectors") {
    // Key "12345678901234567890" (the RFC's SHA-1 key), base32-encoded.
    const std::string secret = Totp::Base32Encode("12345678901234567890");
    REQUIRE(secret == kSecret);

    // The RFC publishes 8-digit values; we emit 6, which is the low 6 digits
    // of the same number — that relationship is itself part of the standard
    // (RFC 4226 §5.3 truncates modulo 10^Digit).
    struct V { int64_t unixTime; const char* code8; };
    const V vectors[] = {
        {         59, "94287082"},
        { 1111111109, "07081804"},
        { 1111111111, "14050471"},
        { 1234567890, "89005924"},
        { 2000000000, "69279037"},
        {20000000000, "65353130"},
    };
    for (const auto& v : vectors) {
        const std::string want = std::string(v.code8).substr(2);
        CHECK(Totp::CodeForStep(secret, v.unixTime / Totp::kStepSeconds) == want);
    }
}

TEST_CASE("Totp: verification accepts one step of drift and no more") {
    const int64_t now = 1'700'000'000;
    const int64_t step = now / Totp::kStepSeconds;

    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step), now, 0) == step);
    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step - 1), now, 0) == step - 1);
    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step + 1), now, 0) == step + 1);

    // Two steps out is refused in both directions. The window is a security
    // parameter, not a tolerance to be widened when somebody's clock drifts.
    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step - 2), now, 0) == 0);
    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step + 2), now, 0) == 0);

    // Shape rejections: a 6-digit field is not a free-text field.
    CHECK(Totp::VerifyCode(kSecret, "", now, 0) == 0);
    CHECK(Totp::VerifyCode(kSecret, "12345", now, 0) == 0);
    CHECK(Totp::VerifyCode(kSecret, "1234567", now, 0) == 0);
    // A code typed with a space in the middle still verifies — the same
    // normalisation the recovery codes get, for the same reason.
    const std::string c = Totp::CodeForStep(kSecret, step);
    CHECK(Totp::VerifyCode(kSecret, c.substr(0, 3) + " " + c.substr(3), now, 0) == step);
}

TEST_CASE("Totp: a code cannot be spent twice inside its window") {
    const int64_t now  = 1'700'000'000;
    const int64_t step = now / Totp::kStepSeconds;
    const std::string code = Totp::CodeForStep(kSecret, step);

    // First presentation succeeds and yields the step the caller must persist.
    const int64_t accepted = Totp::VerifyCode(kSecret, code, now, 0);
    REQUIRE(accepted == step);

    // Second presentation, still inside the same 30 s window, with the floor
    // now recorded: refused. Without the floor this returns `step` again and
    // an observed code opens a second session.
    CHECK(Totp::VerifyCode(kSecret, code, now, accepted) == 0);

    // And the floor does not lock the account out — the NEXT step still works.
    CHECK(Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, step + 1),
                           now + Totp::kStepSeconds, accepted) == step + 1);

    // The drift window must not reopen a spent step either: at now + 30 s the
    // previous step is inside the window, and it is still refused.
    CHECK(Totp::VerifyCode(kSecret, code, now + Totp::kStepSeconds, accepted) == 0);
}

TEST_CASE("Totp: verification walks newest-first so the floor never goes backwards") {
    // A secret whose codes collide across steps would break this, so the
    // property is stated over the API rather than over a hand-picked pair:
    // whatever matches, the returned step is the newest one that does.
    const int64_t now  = 1'700'000'000;
    const int64_t step = now / Totp::kStepSeconds;
    for (int64_t s = step - 1; s <= step + 1; ++s) {
        const int64_t got = Totp::VerifyCode(kSecret, Totp::CodeForStep(kSecret, s), now, 0);
        CHECK(got >= s);
    }
}

TEST_CASE("Totp: an enrolment is not live until it is confirmed") {
    TestDb t;
    const int64_t now  = 1'700'000'000;
    const int64_t step = now / Totp::kStepSeconds;

    CHECK_FALSE(Totp::Load(t.db, kUser).has_value());
    CHECK_FALSE(Totp::IsEnabled(t.db, kUser));

    REQUIRE(Totp::BeginEnrolment(t.db, kUser, kSecret, now));
    auto pending = Totp::Load(t.db, kUser);
    REQUIRE(pending.has_value());
    CHECK(pending->secret == kSecret);
    CHECK_FALSE(pending->confirmed);
    // The critical one: a pending enrolment must not gate login. If it did,
    // a player whose phone failed to scan would be locked out by the act of
    // opening the settings page.
    CHECK_FALSE(Totp::IsEnabled(t.db, kUser));

    // Restarting enrolment before confirmation replaces the secret — the
    // player pressed the button twice, or scanned on a second device.
    const std::string second = Totp::GenerateSecret();
    REQUIRE(Totp::BeginEnrolment(t.db, kUser, second, now));
    CHECK(Totp::Load(t.db, kUser)->secret == second);

    REQUIRE(Totp::Confirm(t.db, kUser, step, now));
    CHECK(Totp::IsEnabled(t.db, kUser));
    // The confirming code is spent by the confirmation itself, so it is not
    // also the player's first login code.
    CHECK(Totp::Load(t.db, kUser)->lastStep == step);

    // Confirming twice does nothing (there is no pending enrolment), and
    // re-enrolling over a live factor is refused outright: replacing a working
    // second factor with an unproven one is the lockout this state exists to
    // prevent.
    CHECK_FALSE(Totp::Confirm(t.db, kUser, step + 1, now));
    CHECK_FALSE(Totp::BeginEnrolment(t.db, kUser, Totp::GenerateSecret(), now));
    CHECK(Totp::Load(t.db, kUser)->secret == second);
}

TEST_CASE("Totp: the replay floor only ever moves forward") {
    TestDb t;
    const int64_t now = 1'700'000'000;
    REQUIRE(Totp::BeginEnrolment(t.db, kUser, kSecret, now));
    REQUIRE(Totp::Confirm(t.db, kUser, 100, now));

    REQUIRE(Totp::RecordStep(t.db, kUser, 105));
    CHECK(Totp::Load(t.db, kUser)->lastStep == 105);
    // An older step arriving late (two requests racing on one account) must
    // not lower the floor — that would re-open every step in between.
    REQUIRE(Totp::RecordStep(t.db, kUser, 102));
    CHECK(Totp::Load(t.db, kUser)->lastStep == 105);
}

TEST_CASE("Totp: recovery codes are single-use, hashed at rest, and re-issuable") {
    TestDb t;
    const int64_t now = 1'700'000'000;
    REQUIRE(Totp::BeginEnrolment(t.db, kUser, kSecret, now));
    REQUIRE(Totp::Confirm(t.db, kUser, 100, now));

    const auto codes = Totp::IssueRecoveryCodes(t.db, kUser, Totp::kRecoveryCodes, now);
    REQUIRE(codes.size() == static_cast<size_t>(Totp::kRecoveryCodes));
    CHECK(Totp::RemainingRecoveryCodes(t.db, kUser) == Totp::kRecoveryCodes);

    // Every code is distinct — a generator that repeats itself issues one
    // credential ten times over.
    std::set<std::string> distinct(codes.begin(), codes.end());
    CHECK(distinct.size() == codes.size());

    // Nothing is stored in the clear. The needle is the code minus its
    // separator, which is the form that is actually hashed.
    for (const auto& c : codes) {
        std::string raw;
        for (char ch : c) if (ch != '-') raw += ch;
        CHECK_FALSE(AppearsInTable(t.db, "user_totp_recovery", raw));
    }

    // Spend one. It works once, and then never again — a replayable recovery
    // code is a password that does not expire.
    CHECK(Totp::ConsumeRecoveryCode(t.db, kUser, codes[0]));
    CHECK(Totp::RemainingRecoveryCodes(t.db, kUser) == Totp::kRecoveryCodes - 1);
    CHECK_FALSE(Totp::ConsumeRecoveryCode(t.db, kUser, codes[0]));

    // Typed off paper: case and separators are the player's, not ours.
    std::string typed;
    for (char ch : codes[1]) if (ch != '-') typed += static_cast<char>(std::tolower(ch));
    CHECK(Totp::ConsumeRecoveryCode(t.db, kUser, typed));

    // A code belonging to another account does not work here.
    const auto others = Totp::IssueRecoveryCodes(t.db, kUser + 1, 3, now);
    REQUIRE(others.size() == 3);
    CHECK_FALSE(Totp::ConsumeRecoveryCode(t.db, kUser, others[0]));

    // Re-issuing REPLACES the list: a player who re-issues believes the old
    // codes leaked, and leaving them live would make the re-issue a no-op that
    // looks like a fix.
    const auto reissued = Totp::IssueRecoveryCodes(t.db, kUser, Totp::kRecoveryCodes, now);
    CHECK(Totp::RemainingRecoveryCodes(t.db, kUser) == Totp::kRecoveryCodes);
    CHECK_FALSE(Totp::ConsumeRecoveryCode(t.db, kUser, codes[2]));
    CHECK(Totp::ConsumeRecoveryCode(t.db, kUser, reissued[0]));
}

TEST_CASE("Totp: disabling removes the factor and its recovery codes together") {
    TestDb t;
    const int64_t now = 1'700'000'000;
    REQUIRE(Totp::BeginEnrolment(t.db, kUser, kSecret, now));
    REQUIRE(Totp::Confirm(t.db, kUser, 100, now));
    const auto codes = Totp::IssueRecoveryCodes(t.db, kUser, 4, now);
    REQUIRE(codes.size() == 4);

    CHECK(Totp::Disable(t.db, kUser));
    CHECK_FALSE(Totp::IsEnabled(t.db, kUser));
    CHECK_FALSE(Totp::Load(t.db, kUser).has_value());
    // The codes go with it. A leftover recovery code is a live credential for
    // a factor that no longer exists — and it survives the next enrolment,
    // which is where it becomes an unowned back door.
    CHECK(Totp::RemainingRecoveryCodes(t.db, kUser) == 0);
    CHECK_FALSE(Totp::ConsumeRecoveryCode(t.db, kUser, codes[0]));

    // Idempotent: "turn it off" must succeed against an account that already
    // has it off, or a half-failed disable strands the player.
    CHECK_FALSE(Totp::Disable(t.db, kUser));

    // And enrolment is available again afterwards.
    CHECK(Totp::BeginEnrolment(t.db, kUser, kSecret, now));
}

TEST_CASE("Totp: the enrolment URI names the issuer twice and escapes the label") {
    const std::string uri = Totp::EnrolmentUri("Spring RTS Web", "player one/two", kSecret);
    // Prefix AND parameter: old apps display the prefix, current ones key on
    // the parameter, and an entry with only one shows up as a bare username.
    CHECK(uri.find("otpauth://totp/Spring%20RTS%20Web:") == 0);
    CHECK(uri.find("issuer=Spring%20RTS%20Web") != std::string::npos);
    // The '/' in the account name is encoded — unescaped it would end the
    // label early and the entry would name a different account than it is for.
    CHECK(uri.find("player%20one%2Ftwo") != std::string::npos);
    CHECK(uri.find("secret=" + kSecret) != std::string::npos);
    CHECK(uri.find("digits=6") != std::string::npos);
    CHECK(uri.find("period=30") != std::string::npos);
    CHECK(Totp::EnrolmentUri("i", "a", "").empty());
}

TEST_CASE("Totp: generated secrets carry their full entropy") {
    const std::string a = Totp::GenerateSecret();
    const std::string b = Totp::GenerateSecret();
    CHECK(a != b);
    // 20 bytes → 32 base32 characters. The bug this catches is base32-encoding
    // the HEX string instead of the bytes behind it, which produces a secret
    // that LOOKS the right length (64 chars) while carrying half the entropy.
    CHECK(a.size() == 32);
    CHECK(Totp::Base32Decode(a).size() == 20);
}
