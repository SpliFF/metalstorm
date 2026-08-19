#include "Server/Totp.h"

#include "Server/AuthTokens.h"
#include "Server/Crypto.h"

#include <openssl/hmac.h>
#include <sqlite3.h>

#include <array>
#include <cctype>
#include <cstdio>
#include <functional>

namespace {

constexpr char kB32Alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

bool Exec(sqlite3* db, const char* sql,
          const std::function<void(sqlite3_stmt*)>& bind) {
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return false;
    }
    bind(stmt);
    const bool ok = sqlite3_step(stmt) == SQLITE_DONE;
    sqlite3_finalize(stmt);
    return ok;
}

/// Compare without an early exit. The values compared here are a 6-digit code
/// and a hash, so the leak is small — but a constant-time compare costs
/// nothing and the alternative is arguing about how small.
bool ConstantTimeEqual(const std::string& a, const std::string& b) {
    if (a.size() != b.size()) return false;
    unsigned char diff = 0;
    for (size_t i = 0; i < a.size(); ++i)
        diff |= static_cast<unsigned char>(a[i] ^ b[i]);
    return diff == 0;
}

/// Percent-encode everything outside the unreserved set. Deliberately strict
/// (it encodes '/' and ' ', which is the point) — an otpauth label is parsed
/// by the scanning app, not by us.
std::string PercentEncode(const std::string& in) {
    static const char* kHex = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : in) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += kHex[c >> 4];
            out += kHex[c & 0x0F];
        }
    }
    return out;
}

/// Strip the separators and case a human introduces when typing a code off
/// paper or out of a formatted secret display.
std::string Normalise(const std::string& in) {
    std::string out;
    for (unsigned char c : in) {
        if (std::isalnum(c))
            out += static_cast<char>(std::toupper(c));
    }
    return out;
}

}  // namespace

namespace Totp {

// ── Arithmetic ─────────────────────────────────────────────────────────────

std::string Base32Encode(const std::string& bytes) {
    std::string out;
    uint32_t buffer = 0;
    int bits = 0;
    for (unsigned char c : bytes) {
        buffer = (buffer << 8) | c;
        bits += 8;
        while (bits >= 5) {
            out += kB32Alphabet[(buffer >> (bits - 5)) & 0x1F];
            bits -= 5;
        }
    }
    // Trailing bits are left-aligned into one final character (RFC 4648 §6).
    if (bits > 0)
        out += kB32Alphabet[(buffer << (5 - bits)) & 0x1F];
    return out;
}

std::string Base32Decode(const std::string& b32) {
    std::string out;
    uint32_t buffer = 0;
    int bits = 0;
    for (unsigned char raw : b32) {
        if (raw == '=' || raw == ' ' || raw == '-') continue;
        const char c = static_cast<char>(std::toupper(raw));
        const char* found = nullptr;
        for (const char* p = kB32Alphabet; *p; ++p) {
            if (*p == c) { found = p; break; }
        }
        // A character outside the alphabet fails the whole decode rather than
        // being skipped: a mistyped secret must not quietly become a different
        // valid secret whose codes never match and produce no error.
        if (!found) return "";
        buffer = (buffer << 5) | static_cast<uint32_t>(found - kB32Alphabet);
        bits += 5;
        if (bits >= 8) {
            out += static_cast<char>((buffer >> (bits - 8)) & 0xFF);
            bits -= 8;
        }
    }
    return out;
}

std::string GenerateSecret(size_t numBytes) {
    // Crypto::GenerateToken returns hex; the bytes behind it are what we want,
    // so decode the hex back rather than base32-ing the hex string (which
    // would give a 160-bit-looking secret carrying only 80 bits of entropy).
    const std::string hex = Crypto::GenerateToken(numBytes);
    if (hex.size() != numBytes * 2) return "";
    std::string bytes;
    bytes.reserve(numBytes);
    for (size_t i = 0; i + 1 < hex.size(); i += 2) {
        auto nib = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        const int hi = nib(hex[i]), lo = nib(hex[i + 1]);
        if (hi < 0 || lo < 0) return "";
        bytes += static_cast<char>((hi << 4) | lo);
    }
    return Base32Encode(bytes);
}

std::string CodeForStep(const std::string& secretB32, int64_t step) {
    const std::string key = Base32Decode(secretB32);
    if (key.empty() || step < 0) return "";

    // RFC 4226 §5.1: the counter is 8 bytes, big-endian.
    std::array<unsigned char, 8> counter{};
    uint64_t c = static_cast<uint64_t>(step);
    for (int i = 7; i >= 0; --i) {
        counter[static_cast<size_t>(i)] = static_cast<unsigned char>(c & 0xFF);
        c >>= 8;
    }

    std::array<unsigned char, EVP_MAX_MD_SIZE> mac{};
    unsigned int macLen = 0;
    if (!HMAC(EVP_sha1(), key.data(), static_cast<int>(key.size()),
              counter.data(), counter.size(), mac.data(), &macLen) ||
        macLen < 20) {
        return "";
    }

    // RFC 4226 §5.3 dynamic truncation.
    const size_t offset = mac[macLen - 1] & 0x0F;
    const uint32_t binary =
        (static_cast<uint32_t>(mac[offset]     & 0x7F) << 24) |
        (static_cast<uint32_t>(mac[offset + 1] & 0xFF) << 16) |
        (static_cast<uint32_t>(mac[offset + 2] & 0xFF) <<  8) |
        (static_cast<uint32_t>(mac[offset + 3] & 0xFF));

    uint32_t modulus = 1;
    for (int i = 0; i < kDigits; ++i) modulus *= 10;
    char buf[16];
    std::snprintf(buf, sizeof(buf), "%0*u", kDigits, binary % modulus);
    return buf;
}

int64_t VerifyCode(const std::string& secretB32, const std::string& code,
                   int64_t now, int64_t lastAcceptedStep, int driftSteps) {
    const std::string presented = Normalise(code);
    if (secretB32.empty() || presented.size() != static_cast<size_t>(kDigits))
        return 0;
    if (now < 0) return 0;

    const int64_t current = now / kStepSeconds;
    // Walk newest-first so the step returned is the latest one that matches —
    // which matters because the step is the replay floor: accepting the
    // *oldest* matching step would leave the newer ones spendable again.
    for (int64_t s = current + driftSteps; s >= current - driftSteps; --s) {
        if (s < 0 || s <= lastAcceptedStep) continue;
        const std::string expected = CodeForStep(secretB32, s);
        if (!expected.empty() && ConstantTimeEqual(expected, presented))
            return s;
    }
    return 0;
}

std::string EnrolmentUri(const std::string& issuer, const std::string& account,
                         const std::string& secretB32) {
    if (secretB32.empty()) return "";
    // The label carries the issuer as a prefix AND the query carries it as a
    // parameter: the prefix is what old apps display, the parameter is what
    // current ones key on, and an entry with only one of the two shows up in
    // the player's app as a bare username with no idea which game it is.
    std::string uri = "otpauth://totp/" + PercentEncode(issuer) + ":" +
                      PercentEncode(account) + "?secret=" + secretB32 +
                      "&issuer=" + PercentEncode(issuer) +
                      "&algorithm=SHA1&digits=" + std::to_string(kDigits) +
                      "&period=" + std::to_string(kStepSeconds);
    return uri;
}

// ── Enrolment storage ──────────────────────────────────────────────────────

void EnsureTables(sqlite3* db) {
    if (!db) return;
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS user_totp ("
        "  user_id INTEGER PRIMARY KEY,"
        "  secret TEXT NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  confirmed_at INTEGER NOT NULL DEFAULT 0,"
        "  last_step INTEGER NOT NULL DEFAULT 0"
        ")", nullptr, nullptr, nullptr);
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS user_totp_recovery ("
        "  user_id INTEGER NOT NULL,"
        "  code_hash TEXT NOT NULL,"
        "  created_at INTEGER NOT NULL DEFAULT 0,"
        "  PRIMARY KEY (user_id, code_hash)"
        ")", nullptr, nullptr, nullptr);
}

std::optional<Enrolment> Load(sqlite3* db, int64_t userId) {
    if (!db || userId <= 0) return std::nullopt;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT secret, confirmed_at, last_step FROM user_totp "
            "WHERE user_id=?", -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return std::nullopt;
    }
    sqlite3_bind_int64(stmt, 1, userId);
    std::optional<Enrolment> out;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        Enrolment e;
        if (const unsigned char* s = sqlite3_column_text(stmt, 0))
            e.secret = reinterpret_cast<const char*>(s);
        e.confirmed = sqlite3_column_int64(stmt, 1) != 0;
        e.lastStep  = sqlite3_column_int64(stmt, 2);
        out = e;
    }
    sqlite3_finalize(stmt);
    return out;
}

bool IsEnabled(sqlite3* db, int64_t userId) {
    auto e = Load(db, userId);
    return e && e->confirmed;
}

bool BeginEnrolment(sqlite3* db, int64_t userId, const std::string& secretB32,
                    int64_t now) {
    if (!db || userId <= 0 || secretB32.empty()) return false;
    // A confirmed enrolment is not replaceable in place — see the header. The
    // check is here rather than at the route so that every future caller
    // inherits it.
    if (IsEnabled(db, userId)) return false;
    return Exec(db,
        "INSERT INTO user_totp (user_id, secret, created_at, confirmed_at, last_step) "
        "VALUES (?, ?, ?, 0, 0) "
        "ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,"
        " created_at=excluded.created_at, confirmed_at=0, last_step=0",
        [&](sqlite3_stmt* s) {
            sqlite3_bind_int64(s, 1, userId);
            BindText(s, 2, secretB32);
            sqlite3_bind_int64(s, 3, now);
        });
}

bool Confirm(sqlite3* db, int64_t userId, int64_t step, int64_t now) {
    if (!db || userId <= 0) return false;
    const bool ok = Exec(db,
        "UPDATE user_totp SET confirmed_at=?, last_step=? "
        "WHERE user_id=? AND confirmed_at=0",
        [&](sqlite3_stmt* s) {
            sqlite3_bind_int64(s, 1, now);
            sqlite3_bind_int64(s, 2, step);
            sqlite3_bind_int64(s, 3, userId);
        });
    return ok && sqlite3_changes(db) > 0;
}

bool RecordStep(sqlite3* db, int64_t userId, int64_t step) {
    if (!db || userId <= 0) return false;
    // `MAX` rather than an assignment: two requests racing on one account must
    // not be able to move the replay floor backwards.
    return Exec(db,
        "UPDATE user_totp SET last_step=MAX(last_step, ?) WHERE user_id=?",
        [&](sqlite3_stmt* s) {
            sqlite3_bind_int64(s, 1, step);
            sqlite3_bind_int64(s, 2, userId);
        });
}

bool Disable(sqlite3* db, int64_t userId) {
    if (!db || userId <= 0) return false;
    Exec(db, "DELETE FROM user_totp WHERE user_id=?",
         [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, userId); });
    const bool had = sqlite3_changes(db) > 0;
    Exec(db, "DELETE FROM user_totp_recovery WHERE user_id=?",
         [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, userId); });
    return had;
}

// ── Recovery codes ─────────────────────────────────────────────────────────

std::vector<std::string> IssueRecoveryCodes(sqlite3* db, int64_t userId,
                                            int count, int64_t now) {
    std::vector<std::string> codes;
    if (!db || userId <= 0 || count <= 0) return codes;
    Exec(db, "DELETE FROM user_totp_recovery WHERE user_id=?",
         [&](sqlite3_stmt* s) { sqlite3_bind_int64(s, 1, userId); });

    for (int i = 0; i < count; ++i) {
        // 10 base32 characters = 50 bits, shown as two groups of five. Base32
        // rather than hex because these are read off a screen and typed back:
        // the alphabet has no 0/O or 1/I pair to confuse.
        const std::string raw = GenerateSecret(/*numBytes=*/7).substr(0, 10);
        if (raw.size() != 10) continue;
        const std::string display = raw.substr(0, 5) + "-" + raw.substr(5);
        const bool ok = Exec(db,
            "INSERT OR IGNORE INTO user_totp_recovery "
            "  (user_id, code_hash, created_at) VALUES (?, ?, ?)",
            [&](sqlite3_stmt* s) {
                sqlite3_bind_int64(s, 1, userId);
                BindText(s, 2, AuthTokens::HashToken(raw));
                sqlite3_bind_int64(s, 3, now);
            });
        if (ok) codes.push_back(display);
    }
    return codes;
}

bool ConsumeRecoveryCode(sqlite3* db, int64_t userId, const std::string& code) {
    if (!db || userId <= 0) return false;
    const std::string normalised = Normalise(code);
    if (normalised.empty()) return false;
    // The delete IS the check: a select-then-delete would let two concurrent
    // requests both spend the same single-use code.
    Exec(db, "DELETE FROM user_totp_recovery WHERE user_id=? AND code_hash=?",
         [&](sqlite3_stmt* s) {
             sqlite3_bind_int64(s, 1, userId);
             BindText(s, 2, AuthTokens::HashToken(normalised));
         });
    return sqlite3_changes(db) > 0;
}

int RemainingRecoveryCodes(sqlite3* db, int64_t userId) {
    if (!db || userId <= 0) return 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db,
            "SELECT COUNT(*) FROM user_totp_recovery WHERE user_id=?",
            -1, &stmt, nullptr) != SQLITE_OK) {
        sqlite3_finalize(stmt);
        return 0;
    }
    sqlite3_bind_int64(stmt, 1, userId);
    int n = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) n = sqlite3_column_int(stmt, 0);
    sqlite3_finalize(stmt);
    return n;
}

}  // namespace Totp
