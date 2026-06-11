// Crypto — security primitives for auth (S1, S3).
//
// Two responsibilities, both backed by OpenSSL libcrypto (already linked
// for the QUIC stack):
//   - GenerateToken(): cryptographically-secure random session tokens via
//     RAND_bytes (replaces the predictable std::mt19937 generators that
//     used to live in HttpAuth.h and ClientMessageHandler.cpp).
//   - HashPassword()/VerifyPassword(): scrypt password hashing with a random
//     per-password salt. Stored format is self-describing so parameters can
//     evolve without a schema change. A legacy plaintext value (anything that
//     doesn't carry the scheme prefix) still verifies by direct compare and
//     reports needsRehash=true so callers can upgrade it on next login.
#pragma once

#include <string>

namespace Crypto {

/// Random hex token of `numBytes` bytes (so the string is 2*numBytes chars).
/// Cryptographically secure (OpenSSL RAND_bytes). Default 16 bytes = 128 bits,
/// matching the old 32-hex-char token width.
std::string GenerateToken(size_t numBytes = 16);

/// Hash a plaintext password with scrypt and a fresh random salt. Returns an
/// encoded string ("scrypt$N$r$p$saltHex$hashHex"). Returns empty on failure.
std::string HashPassword(const std::string& password);

/// Verify `password` against a previously stored value. Sets `needsRehash` to
/// true when the stored value should be replaced with a fresh HashPassword()
/// result (legacy plaintext, or outdated scrypt parameters). Returns true iff
/// the password matches.
bool VerifyPassword(const std::string& password, const std::string& stored,
                    bool& needsRehash);

} // namespace Crypto
