// AuthTokens — the two long-lived credentials an account holds beyond its
// short access session: a ROTATING REFRESH TOKEN (so a player is not asked for
// their password again every time the access session ages out) and a PER-WAR
// RECONNECT TOKEN (so a player who closed the browser mid-war can walk back
// into that war, and only that war).
//
// PLAN-metalstorm-lobby.md §7.2 ("Session/token management for long sessions":
// short-lived access token + a longer-lived refresh token, rotating, revocable,
// stored hashed) and §7.3 ("Reconnection tokens for persistent wars": a
// per-(account, war) token with a long TTL, bound to the war so it cannot be
// replayed against a different one). Task 8a.
//
// ── Why hashed at rest, and why not scrypt ─────────────────────────────────
// `sessions.token` is stored in the clear, which is defensible for a 24 h
// credential but not for one that lives for a month: a read of the db file is
// a month of impersonation for every account in it. So both tables here store
// only sha256(token) and the raw value is returned to the caller exactly once,
// at issue.
//
// sha256 rather than Crypto::HashPassword: a password is low-entropy and needs
// the work factor to survive an offline dictionary attack. These tokens are 32
// bytes of CSPRNG output — there is no dictionary — so the only property
// wanted is one-wayness, and scrypt would put its whole cost on the *validate*
// path, which the game server hits on every reconnect.
//
// ── Rotation and reuse detection ───────────────────────────────────────────
// A refresh token is single-use: presenting it mints a successor in the same
// FAMILY and marks the presented row used. Presenting an already-used row is
// the signature of a stolen token being replayed (the legitimate client has
// already rotated past it), and the response is to revoke the whole family —
// the standard mitigation, because at that point we cannot tell the thief from
// the victim and only one of the two can re-authenticate with a password.
//
// ── Why the war token is a separate credential and not a longer session ────
// A session token is an account-wide bearer credential: it authorises the
// lobby API, room creation, the GM surface. A war reconnect token authorises
// exactly one thing — "seat this account in room N" — and that is why it can
// safely live for a week. `ValidateWarReconnect` takes the roomId as an
// argument rather than returning it, so a caller physically cannot forget to
// check it; a token minted for one war returns 0 against another.
#pragma once

#include <cstdint>
#include <optional>
#include <string>

struct sqlite3;

namespace AuthTokens {

/// Default lifetimes. Named rather than inline literals because the security
/// argument for each is different (see the header comment) and a future change
/// to one must not look like a change to the other.
constexpr int kRefreshTtlSeconds      = 30 * 24 * 60 * 60;  // 30 days
constexpr int kWarReconnectTtlSeconds =  7 * 24 * 60 * 60;  // 7 days

/// The access session's lifetime — shortened from 24 h to 1 h by 8a-follow-on.
///
/// It lives HERE rather than in HttpAuth.h (where task 8a put it) because it
/// had two independent readers and only one of them named it: the lobby's
/// `ValidateSession(token, kAccessTtlSeconds)` calls, and the *game* server's
/// `db.ValidateSession(token)` in ClientMessageHandler, which took
/// `Database.h`'s 86400 default argument. Those were the same number by
/// coincidence, so shrinking the lobby's constant alone would have left every
/// game server accepting a 24 h-old bearer token — the exact hole the short
/// TTL exists to close, in the one process that is exposed to the internet on
/// a per-room port. AuthTokens.h is the header both of them already include.
///
/// 1 h rather than the 15 min a pure OAuth reading suggests: the credential is
/// renewed by a timer in the browser (auth-tokens.ts), and every renewal spends
/// a rotation of the 30-day refresh family. At 15 min an idle tab left open
/// overnight burns ~96 generations and four times the reuse-detection surface,
/// for a window that is already two orders of magnitude below the refresh
/// token's. The blast radius of a leaked access token is what shrank 24×; the
/// rotation rate is what we decline to grow 4× further.
constexpr int kAccessTtlSeconds = 60 * 60;

/// Lowercase hex sha256 of `raw`. Exposed for tests and for the callers that
/// need to look a token up without holding it (there are none today, but the
/// alternative is every one of them re-deriving the digest).
std::string HashToken(const std::string& raw);

/// Create both tables if absent. Additive migration only — these hold the only
/// copy of a live credential, so a probe-and-drop would log every player out
/// (same reasoning as WarPlayerBindings::EnsureTable).
void EnsureTables(sqlite3* db);

// ── Refresh tokens ─────────────────────────────────────────────────────────

/// A freshly minted refresh token. `token` is the only time the raw value
/// exists outside the client — nothing stores it.
struct RefreshIssue {
    std::string token;
    std::string familyId;
};

/// Mint a refresh token in a NEW family. Called at login and registration:
/// each password authentication starts its own lineage, so revoking a
/// compromised family never touches the session the player just opened.
std::optional<RefreshIssue> IssueRefresh(sqlite3* db, int64_t userId,
                                         int ttlSeconds, int64_t now);

enum class RefreshStatus {
    OK,       ///< rotated; `next` holds the successor
    Unknown,  ///< no such token (or already pruned)
    Expired,  ///< past its TTL
    Revoked,  ///< family was revoked (logout-all, or an earlier reuse)
    Reused,   ///< presented a token that had already been rotated — family killed
};

struct RefreshOutcome {
    RefreshStatus status = RefreshStatus::Unknown;
    int64_t       userId = 0;
    RefreshIssue  next;
};

/// Rotate: validate `presented`, mark it used, and mint its successor in the
/// same family. The three failure modes are kept distinct rather than collapsed
/// to a bool because `Reused` is a security event (it revokes the family) and
/// `Expired` is an ordinary Tuesday.
RefreshOutcome Rotate(sqlite3* db, const std::string& presented,
                      int ttlSeconds, int64_t now);

/// Revoke every token in a family. Returns rows affected.
int RevokeFamily(sqlite3* db, const std::string& familyId, int64_t now);

/// Revoke the family the presented token belongs to, whatever its state. This
/// is what logout calls: a logout must succeed even against an already-expired
/// token, so it deliberately does not go through Rotate's status ladder.
/// Returns rows affected (0 when the token is unknown).
int RevokeFamilyOfToken(sqlite3* db, const std::string& presented, int64_t now);

/// Revoke every refresh family an account holds — the "log out everywhere"
/// half. Paired with Database::RevokeUserSessions by the route; on its own it
/// only stops future refreshes, it does not end sessions already open.
int RevokeAllRefreshForUser(sqlite3* db, int64_t userId, int64_t now);

// ── Per-war reconnect tokens ───────────────────────────────────────────────

/// Mint a reconnect token for (account, war). Does NOT revoke this account's
/// existing tokens for the same war: §7.4 allows an account to hold seats from
/// more than one device, and re-issuing on the desktop must not silently log
/// the phone out of the war. They expire instead.
std::optional<std::string> IssueWarReconnect(sqlite3* db, int64_t accountId,
                                             uint32_t roomId, int ttlSeconds,
                                             int64_t now);

/// Returns the account id this token seats, or 0. `roomId` is an argument, not
/// a result: a token minted for another war must not authenticate here, and
/// making the caller pass the war it is standing in is the only shape where
/// forgetting that check is impossible.
int64_t ValidateWarReconnect(sqlite3* db, const std::string& presented,
                             uint32_t roomId, int64_t now);

/// Revoke every war token an account holds in a war (the audited faction
/// override clears bindings; a live token would otherwise re-seat the account
/// on the side it was just moved off). Returns rows affected.
int RevokeWarReconnectForAccount(sqlite3* db, int64_t accountId, int64_t now);

/// Drop rows that expired more than `graceSeconds` ago, in both tables.
/// Returns rows deleted. Nothing else prunes these: unlike `sessions` they are
/// long-lived by design, so without this they are the one table that grows for
/// the life of the deployment.
int PruneExpired(sqlite3* db, int64_t now, int graceSeconds = 24 * 60 * 60);

}  // namespace AuthTokens
