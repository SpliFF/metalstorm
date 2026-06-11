#include "Crypto.h"

#include <openssl/rand.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>

#include <array>
#include <cstdint>
#include <cstdlib>
#include <vector>

namespace {

constexpr char kHexDigits[] = "0123456789abcdef";

std::string ToHex(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve(len * 2);
    for (size_t i = 0; i < len; ++i) {
        out += kHexDigits[data[i] >> 4];
        out += kHexDigits[data[i] & 0x0F];
    }
    return out;
}

bool FromHex(const std::string& hex, std::vector<uint8_t>& out) {
    if (hex.size() % 2 != 0) return false;
    auto nibble = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    out.clear();
    out.reserve(hex.size() / 2);
    for (size_t i = 0; i < hex.size(); i += 2) {
        const int hi = nibble(hex[i]);
        const int lo = nibble(hex[i + 1]);
        if (hi < 0 || lo < 0) return false;
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }
    return true;
}

// scrypt cost parameters. N=2^15 (32768), r=8, p=1 → ~32 MB, ~50–100 ms per
// hash on a modern core. The encoded hash records these so they can be raised
// later without breaking existing stored values (VerifyPassword flags a
// mismatch as needsRehash).
constexpr uint64_t kScryptN = 1u << 15;
constexpr uint64_t kScryptR = 8;
constexpr uint64_t kScryptP = 1;
constexpr size_t   kSaltLen = 16;
constexpr size_t   kKeyLen  = 32;
// scrypt memory ceiling: ~128 * N * r bytes plus headroom.
constexpr uint64_t kScryptMaxMem = 64ull * 1024 * 1024;

const char* kScryptPrefix = "scrypt$";

bool DeriveScrypt(const std::string& password,
                  const uint8_t* salt, size_t saltLen,
                  uint64_t N, uint64_t r, uint64_t p,
                  uint8_t* out, size_t outLen) {
    return EVP_PBE_scrypt(
        password.data(), password.size(),
        salt, saltLen,
        N, r, p, kScryptMaxMem,
        out, outLen) == 1;
}

} // namespace

namespace Crypto {

std::string GenerateToken(size_t numBytes) {
    std::vector<uint8_t> buf(numBytes);
    if (RAND_bytes(buf.data(), static_cast<int>(buf.size())) != 1) {
        // RAND_bytes should never fail with a properly seeded OpenSSL, but if
        // it does we must not fall back to a predictable source — return empty
        // so the caller's session-create fails closed rather than issuing a
        // guessable token.
        return "";
    }
    return ToHex(buf.data(), buf.size());
}

std::string HashPassword(const std::string& password) {
    std::array<uint8_t, kSaltLen> salt{};
    if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1)
        return "";

    std::array<uint8_t, kKeyLen> key{};
    if (!DeriveScrypt(password, salt.data(), salt.size(),
                      kScryptN, kScryptR, kScryptP, key.data(), key.size()))
        return "";

    return std::string(kScryptPrefix)
        + std::to_string(kScryptN) + "$"
        + std::to_string(kScryptR) + "$"
        + std::to_string(kScryptP) + "$"
        + ToHex(salt.data(), salt.size()) + "$"
        + ToHex(key.data(), key.size());
}

bool VerifyPassword(const std::string& password, const std::string& stored,
                    bool& needsRehash) {
    needsRehash = false;

    // Legacy plaintext (or anything not in our scheme): compare directly and
    // request a rehash on success so the next login upgrades it.
    const std::string prefix(kScryptPrefix);
    if (stored.compare(0, prefix.size(), prefix) != 0) {
        if (!stored.empty() && password == stored) {
            needsRehash = true;
            return true;
        }
        return false;
    }

    // Parse "scrypt$N$r$p$saltHex$hashHex".
    std::array<std::string, 5> fields;
    size_t pos = prefix.size();
    for (int i = 0; i < 5; ++i) {
        const size_t next = stored.find('$', pos);
        if (i < 4) {
            if (next == std::string::npos) return false;
            fields[i] = stored.substr(pos, next - pos);
            pos = next + 1;
        } else {
            fields[i] = stored.substr(pos);
        }
    }

    const uint64_t N = std::strtoull(fields[0].c_str(), nullptr, 10);
    const uint64_t r = std::strtoull(fields[1].c_str(), nullptr, 10);
    const uint64_t p = std::strtoull(fields[2].c_str(), nullptr, 10);
    std::vector<uint8_t> salt, expected;
    if (N == 0 || r == 0 || p == 0) return false;
    if (!FromHex(fields[3], salt) || !FromHex(fields[4], expected)) return false;
    if (expected.empty()) return false;

    std::vector<uint8_t> actual(expected.size());
    if (!DeriveScrypt(password, salt.data(), salt.size(), N, r, p,
                      actual.data(), actual.size()))
        return false;

    if (CRYPTO_memcmp(actual.data(), expected.data(), expected.size()) != 0)
        return false;

    // Match — flag a rehash if the stored cost parameters are weaker than
    // current policy so the value gets upgraded on next login.
    if (N != kScryptN || r != kScryptR || p != kScryptP)
        needsRehash = true;
    return true;
}

} // namespace Crypto
