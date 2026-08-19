// Totp — optional second factor for accounts that hold durable value.
//
// PLAN-metalstorm-lobby.md §7.2 ("Password hashing stays bcrypt; add optional
// 2FA/TOTP for accounts with progress/roles"), task 8d. RFC 6238 (TOTP) over
// RFC 4226 (HOTP), HMAC-SHA1, 30-second steps, 6 digits — not a choice, that
// is what every authenticator app on a player's phone implements, and an
// enrolment that only works with one vendor's app is worse than none.
//
// ── Why this file holds both the arithmetic and the table ──────────────────
// The two halves are one security property. The replay rule below is stated in
// terms of a column (`last_step`) and enforced by a comparison in VerifyCode;
// splitting them across a "pure" and a "storage" module would let a caller do
// the comparison and forget the write, which is the shape where a stolen code
// stays usable for its whole 30-second window. `VerifyCode` therefore takes
// the last accepted step as an argument and returns the step it matched, so
// the caller physically has a step to store.
//
// ── The three states an account is in, and why "pending" is one of them ────
// An enrolment is created UNCONFIRMED: the secret exists server-side, but the
// account is not yet protected by it and login is unaffected. It becomes
// confirmed only when the player proves they can generate a code from it.
// Without that intermediate state, a player whose phone failed to scan the
// secret is locked out of their own account by the act of visiting the
// settings page — the enrolment would be live before anything demonstrated it
// worked. Nothing but `Confirm` sets `confirmed_at`, and only a confirmed
// enrolment is ever consulted at login.
//
// ── Recovery codes ─────────────────────────────────────────────────────────
// A lost phone is a lost account otherwise, and "email us" is not a mechanism
// this deployment has. Ten single-use codes are minted at confirmation, hashed
// at rest with the same sha256 the token tables use (32 bytes of CSPRNG has no
// dictionary — see AuthTokens.h for the full argument against scrypt here) and
// shown exactly once. A recovery code is accepted anywhere a TOTP code is, and
// consuming one is a one-way delete: a code that could be replayed is a
// password that never expires.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

namespace Totp {

/// RFC 6238 defaults. Named because a deployment that changes one of them
/// stops interoperating with the player's existing authenticator entry, which
/// is a migration and not a tweak.
constexpr int kStepSeconds   = 30;
constexpr int kDigits        = 6;
/// Accept the immediately-previous and immediately-next step as well as the
/// current one (±30 s of clock skew). RFC 6238 §5.2 recommends "at most one
/// time step"; a wider window multiplies an attacker's guessing surface by the
/// same factor it buys tolerance.
constexpr int kDriftSteps    = 1;
/// How many recovery codes an enrolment mints.
constexpr int kRecoveryCodes = 10;

// ── Arithmetic (no database) ───────────────────────────────────────────────

/// RFC 4648 base32, uppercase, unpadded. Unpadded because that is the form
/// every authenticator app's manual-entry field expects; padding is accepted
/// on the way back in.
std::string Base32Encode(const std::string& bytes);

/// Decode RFC 4648 base32. Case-insensitive, tolerant of '=' padding and of
/// the spaces we deliberately introduce when displaying a secret. Returns the
/// empty string for input containing any character outside the alphabet —
/// silently skipping a bad character would decode a typo'd secret to something
/// plausible and the player would get codes that never verify with no error
/// anywhere.
std::string Base32Decode(const std::string& b32);

/// A fresh base32 secret. 20 bytes = 160 bits, the SHA-1 block-matched size
/// RFC 4226 §4 specifies as the minimum shared-secret length.
std::string GenerateSecret(size_t numBytes = 20);

/// The RFC 6238 code for `secretB32` at counter `step` (= unixTime /
/// kStepSeconds), zero-padded to kDigits. Empty string if the secret does not
/// decode.
std::string CodeForStep(const std::string& secretB32, int64_t step);

/// Verify `code` against `secretB32` around `now`, refusing any step at or
/// below `lastAcceptedStep`.
///
/// Returns the matched step (always > lastAcceptedStep) or 0 for no match.
/// The return type is a step rather than a bool so that the caller has
/// something to persist — see the header comment on replay.
///
/// `lastAcceptedStep` of 0 means "no code has been accepted yet".
int64_t VerifyCode(const std::string& secretB32, const std::string& code,
                   int64_t now, int64_t lastAcceptedStep,
                   int driftSteps = kDriftSteps);

/// The `otpauth://totp/...` URI an authenticator consumes. The client renders
/// it (as a QR, or as text to type); nothing server-side ever draws it.
/// `issuer` and `account` are percent-encoded here rather than by the caller,
/// because a username containing a space or a '/' otherwise produces a URI
/// that scans into a different account label than the one it names.
std::string EnrolmentUri(const std::string& issuer, const std::string& account,
                         const std::string& secretB32);

// ── Enrolment storage ──────────────────────────────────────────────────────

/// Create both tables if absent. Additive only — `user_totp` holds the only
/// copy of a live second factor, so a probe-and-drop migration would silently
/// disable 2FA for every account that had it (and, worse, would look like a
/// successful start-up).
void EnsureTables(sqlite3* db);

struct Enrolment {
    std::string secret;        ///< base32, as handed to the authenticator
    bool        confirmed = false;
    int64_t     lastStep  = 0; ///< highest step ever accepted (replay floor)
};

/// The account's enrolment, confirmed or not. `std::nullopt` when it has none.
std::optional<Enrolment> Load(sqlite3* db, int64_t userId);

/// Is this account protected right now? The one question every login path
/// asks, kept as its own verb so no caller has to remember that an unconfirmed
/// row does not count.
bool IsEnabled(sqlite3* db, int64_t userId);

/// Begin (or restart) enrolment with a fresh secret. Returns false when the
/// account already has a CONFIRMED enrolment: re-enrolling would otherwise
/// replace a working second factor with an unproven one, so disabling first is
/// mandatory and disabling requires the password.
bool BeginEnrolment(sqlite3* db, int64_t userId, const std::string& secretB32,
                    int64_t now);

/// Mark the enrolment confirmed and record the step that proved it (which is
/// immediately spent — the code the player just typed cannot also be their
/// first login code). Returns false if there is no pending enrolment.
bool Confirm(sqlite3* db, int64_t userId, int64_t step, int64_t now);

/// Persist the replay floor after a successful verification. Separate from
/// VerifyCode because the arithmetic has no database, and separate from
/// Confirm because the overwhelming majority of calls are ordinary logins.
bool RecordStep(sqlite3* db, int64_t userId, int64_t step);

/// Remove the enrolment and every recovery code with it. Returns true if there
/// was one. Idempotent by design: "turn it off" must succeed against an
/// account that already has it off, or a half-failed disable strands the
/// player.
bool Disable(sqlite3* db, int64_t userId);

// ── Recovery codes ─────────────────────────────────────────────────────────

/// Replace this account's recovery codes with `count` fresh ones and return
/// the RAW values — the only time they exist outside the player's hands.
/// Replacing rather than appending: a re-issue is what a player does when they
/// think the old list leaked.
std::vector<std::string> IssueRecoveryCodes(sqlite3* db, int64_t userId,
                                            int count, int64_t now);

/// Spend one recovery code. Returns true if it matched an unused one, which is
/// then deleted. Case- and separator-insensitive, because these are typed off
/// paper.
bool ConsumeRecoveryCode(sqlite3* db, int64_t userId, const std::string& code);

/// How many unspent codes remain. Shown to the player: running out silently is
/// how a recovery mechanism turns out not to exist on the day it is needed.
int RemainingRecoveryCodes(sqlite3* db, int64_t userId);

}  // namespace Totp
