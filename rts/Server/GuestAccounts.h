// GuestAccounts — provisional accounts that upgrade into full ones without
// losing what they built up as a guest.
//
// PLAN-metalstorm-lobby.md §7.1 ("Guest / trial accounts that can upgrade to a
// full account without losing progress — a guest can spectate or join a
// low-stakes war, then bind an email/OAuth later and keep their bindings.
// Guest = a real account row with a `provisional` flag + device token").
// Task 8c.
//
// ── The design call: the upgrade does not move the account ─────────────────
// "Carry the progress across" reads like a migration — copy the guest's rows
// onto the new account, then retire the old one. It is not. Everything durable
// an account owns is keyed on `users.id`: `war_player_bindings.account_id`
// (the seat AND the saved per-player war state, task 4),
// `war_reconnect_tokens.account_id` (task 8a), `command_presets.user_id`,
// `admin_audit.user_id`. So the upgrade is an UPDATE on the row that already
// exists — it installs a password, clears the provisional flag, and confirms
// the faction. Nothing is copied, so nothing can be missed by the copier, and
// a future table keyed on the account id inherits the property for free.
//
// The corollary is the constraint: an upgrade is not a merge. There is no
// path here for "I was a guest, and I also already have an account" — that
// wants a real merge with a rule for every conflicting field, and it is not
// this task (see §7.1's OAuth half, task 8b).
//
// ── Why a provisional faction is mutable and a confirmed one is not ────────
// §1a makes `users.faction_id` permanent, set at sign-up, with only an
// audited admin override to change it. A guest never went through sign-up, so
// the faction it holds is *provisional* (§1a's own wording: "Nullable only for
// guests pre-upgrade") and the upgrade is that account's sign-up moment — the
// point where the choice becomes binding.
//
// Which means an upgrade that CHANGES the faction is doing exactly what the
// audited admin override does, and it inherits that rule verbatim: §1b clears
// the account's per-war bindings, because a seat is a seat on a side and the
// account has just left that side. So "upgrade without losing progress" is
// true when the faction is kept and deliberately false when it is switched —
// the guest is told which before they commit, and the code cannot do one
// without the other (see DecideUpgrade's `clearsBindings`).
//
// ── Why the device token is not a refresh token ────────────────────────────
// Both are long-lived, hashed-at-rest, opaque bearer strings, and the shape is
// borrowed from AuthTokens on purpose. Two properties differ, and both come
// from the same fact: a guest's device token is the ONLY credential the
// account has.
//   * It does NOT rotate. A rotating token has a reuse-detection response
//     (revoke the family), which for an account with a password is an
//     inconvenience and for a guest is permanent deletion — there is no
//     password to fall back to and no email to recover with. A lost race
//     between two tabs must not cost a guest their war.
//   * It IS revoked by the upgrade. Once the account has a password, a device
//     token left live in a shared browser's localStorage is a password-free
//     back door into what is now a real account. The upgrade response carries
//     a fresh session, so the upgrading device loses nothing.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

struct sqlite3;

namespace GuestAccounts {

/// A guest's device token outlives every other credential in the system: it is
/// how someone who played on Tuesday is still the same person in October.
/// Longer than the 30-day refresh token because there is nothing behind it —
/// an expired refresh token costs a password prompt, an expired device token
/// costs the account.
constexpr int kDeviceTtlSeconds = 90 * 24 * 60 * 60;  // 90 days

/// How long an abandoned guest survives the sweep (see PruneAbandoned). Long
/// enough that "I'll come back at the weekend" works; short enough that the
/// one unauthenticated account-minting route in the app is not an unbounded
/// row source.
constexpr int kAbandonedGuestAgeSeconds = 30 * 24 * 60 * 60;  // 30 days

/// Create the device-token table if absent. Additive only — it holds the sole
/// credential of every guest account, so a probe-and-drop migration would
/// delete players, not rows (same reasoning as AuthTokens::EnsureTables).
void EnsureTables(sqlite3* db);

/// A generated guest username: `guest-` + 8 lowercase hex.
///
/// Random rather than sequential because the username is public (it appears in
/// every roster and chat line) and a counter would publish the size of the
/// player base and the order people arrived in. The caller retries on
/// collision — 32 bits is not a uniqueness guarantee and this deliberately
/// does not pretend to be one.
std::string GenerateUsername();

/// Mint a device token for `userId`. The raw value is returned exactly once
/// and only its sha256 is stored (AuthTokens::HashToken, shared so there is
/// one digest function in the auth layer rather than two).
std::optional<std::string> IssueDevice(sqlite3* db, int64_t userId,
                                       int ttlSeconds, int64_t now);

/// Returns the account id this device token belongs to, or 0 if it is unknown,
/// expired or revoked. Touches `last_used_at`, which is what PruneAbandoned
/// measures abandonment against — a guest who keeps coming back is never old.
int64_t ValidateDevice(sqlite3* db, const std::string& presented, int64_t now);

/// Revoke every device token an account holds. Called by the upgrade (see the
/// header note) and available to a future "sign out of this device everywhere"
/// verb. Returns rows affected.
int RevokeDevicesForUser(sqlite3* db, int64_t userId, int64_t now);

/// Delete guest accounts that were never upgraded, have not been seen for
/// `maxAgeSeconds`, and hold NO war binding — plus their device tokens.
///
/// The binding check is the whole point and is not an optimisation: a guest
/// who took a seat in a war owns durable state in a running world (task 4's
/// per-player pool and score), and deleting the account would strand it. An
/// abandoned guest that never played is a row; an abandoned guest that played
/// is a player who might come back to a war that is still running.
///
/// Returns accounts deleted.
int PruneAbandoned(sqlite3* db, int64_t now,
                   int maxAgeSeconds = kAbandonedGuestAgeSeconds);

// ── The upgrade decision ───────────────────────────────────────────────────

/// What the caller asked for. Empty fields mean "not supplied", which is a
/// different thing from empty-and-supplied for the username: omitting it keeps
/// the generated guest name.
struct UpgradeRequest {
    std::string username;   ///< optional — keep the guest name if empty
    std::string password;   ///< required
    std::string factionId;  ///< optional — keep the provisional faction if empty
};

/// The account as it stands before the upgrade.
struct AccountState {
    int64_t     id = 0;
    std::string username;
    bool        isProvisional = false;
    std::optional<std::string> factionId;
};

enum class UpgradeStatus {
    OK,
    NotProvisional,   ///< already a full account — upgrading twice is not a thing
    MissingPassword,
    WeakPassword,
    BadUsername,      ///< length/charset
    NameTaken,        ///< somebody else holds it
    NameInUse,        ///< the account is sitting in a room under the old name
    UnknownFaction,
    NoFaction,        ///< no provisional faction and none supplied
};

/// The resolved upgrade: what to write, and what it costs.
struct UpgradePlan {
    UpgradeStatus status = UpgradeStatus::OK;
    std::string   username;        ///< final username (unchanged if not renaming)
    std::string   factionId;       ///< final faction
    bool          renaming = false;
    /// The faction moved, so §1b applies: the account's war bindings and war
    /// reconnect tokens go. Kept as an explicit field rather than recomputed by
    /// the caller from `factionId != before.factionId` — that comparison is
    /// exactly the one somebody eventually writes as `!=` on the wrong pair and
    /// silently stops clearing anything.
    bool          clearsBindings = false;
};

/// Minimum password length for an upgrade. Deliberately stated here rather
/// than inherited from the register route, which has no minimum at all: a
/// guest upgrading is choosing the first password that has ever protected
/// something they care about.
constexpr size_t kMinPasswordLength = 8;

/// Decide, without touching the database.
///
/// `nameIsTaken` and `nameIsInUse` are predicates rather than lookups so the
/// rules above are testable without a schema — and so the two *different*
/// reasons a rename can fail stay separate. They are:
///   * `nameIsTaken` — another account holds it. Ordinary; pick another.
///   * `nameIsInUse` — THIS account is currently a member of a room, which
///     names its players by username (`room_members.username`, and the sim's
///     own roster cross-check in ClientMessageHandler's AuthRequest). A rename
///     under a live roster does not error anywhere; it silently demotes the
///     player, because the roster lookup misses and they fall through to the
///     dynamic-join/spectator path. In a war that lands them back on their own
///     side (task 2 seats by faction) and in a skirmish it makes them a
///     spectator of the game they were playing. Refused rather than repaired.
///
/// A failing rename fails the WHOLE request, before anything is written — the
/// caller retries without a username and keeps the guest name, which is a
/// choice they can make knowingly. A partial upgrade is not a state this
/// system should be able to be in.
UpgradePlan DecideUpgrade(const UpgradeRequest& req, const AccountState& before,
                          bool factionIsKnown,
                          bool nameIsTaken, bool nameIsInUse);

}  // namespace GuestAccounts
