#include <doctest/doctest.h>

#include "Server/Crypto.h"

#include <set>
#include <string>

TEST_CASE("GenerateToken is random, hex, and the requested width") {
    const std::string a = Crypto::GenerateToken();      // 16 bytes -> 32 hex
    const std::string b = Crypto::GenerateToken();
    CHECK(a.size() == 32);
    CHECK(b.size() == 32);
    CHECK(a != b);
    for (char c : a)
        CHECK(((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')));

    CHECK(Crypto::GenerateToken(8).size() == 16);
    CHECK(Crypto::GenerateToken(32).size() == 64);

    // Sanity: a batch of tokens has no collisions.
    std::set<std::string> seen;
    for (int i = 0; i < 256; ++i)
        seen.insert(Crypto::GenerateToken());
    CHECK(seen.size() == 256);
}

TEST_CASE("HashPassword/VerifyPassword round-trips") {
    bool rehash = true;
    const std::string hash = Crypto::HashPassword("correct horse battery staple");
    CHECK(hash.rfind("scrypt$", 0) == 0);

    CHECK(Crypto::VerifyPassword("correct horse battery staple", hash, rehash));
    CHECK(rehash == false);

    CHECK_FALSE(Crypto::VerifyPassword("wrong password", hash, rehash));
}

TEST_CASE("Distinct salts produce distinct hashes for the same password") {
    const std::string h1 = Crypto::HashPassword("hunter2");
    const std::string h2 = Crypto::HashPassword("hunter2");
    CHECK(h1 != h2);

    bool rehash = false;
    CHECK(Crypto::VerifyPassword("hunter2", h1, rehash));
    CHECK(Crypto::VerifyPassword("hunter2", h2, rehash));
}

TEST_CASE("Legacy plaintext verifies and is flagged for rehash") {
    bool rehash = false;
    // Pre-migration rows stored the raw password in password_hash.
    CHECK(Crypto::VerifyPassword("plaintextpw", "plaintextpw", rehash));
    CHECK(rehash == true);

    CHECK_FALSE(Crypto::VerifyPassword("plaintextpw", "different", rehash));
}

TEST_CASE("Malformed stored hashes are rejected, not crash") {
    bool rehash = false;
    CHECK_FALSE(Crypto::VerifyPassword("x", "", rehash));
    CHECK_FALSE(Crypto::VerifyPassword("x", "scrypt$", rehash));
    CHECK_FALSE(Crypto::VerifyPassword("x", "scrypt$32768$8$1$zz$zz", rehash));
}
