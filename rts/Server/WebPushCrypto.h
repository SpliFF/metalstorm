// WebPushCrypto — the pure cryptography under the Web Push offline channel
// (worldsim phase 3 item 3).
//
// Two protocols, both over NIST P-256, both backed by the OpenSSL libcrypto
// the lobby already links:
//   * **VAPID** (RFC 8292): the application server proves it is the party the
//     subscription was minted for by signing a tiny ES256 JWT whose audience
//     is the push service's origin. `SignVapidJwt` builds and signs it;
//     `VapidAuthorizationHeader` wraps it in the `vapid t=…, k=…` header.
//   * **Message encryption** (RFC 8291 / RFC 8188 `aes128gcm`): the payload
//     is ECDH'd against the browser subscription's `p256dh` key, HKDF'd with
//     its `auth` secret, and sealed with AES-128-GCM. The push service can
//     route the message but never read it.
//
// ── Deliberately deterministic where the tests need it ─────────────────────
// `EncryptAes128GcmDeterministic` takes the salt and the ephemeral server
// key as ARGUMENTS, so the whole encryption pipeline is a pure function of
// its inputs and verifies against fixed test vectors (RFC 8291 Appendix A is
// checked verbatim in test_world_offline_channels.cpp, plus an independently
// generated second vector). Production callers use `EncryptAes128Gcm`, which
// draws both from RAND_bytes and delegates.
//
// ── Key register ───────────────────────────────────────────────────────────
// Every key crosses this API base64url-encoded (unpadded), in the formats the
// Push API itself uses: a PRIVATE key is the raw 32-byte P-256 scalar; a
// PUBLIC key is the 65-byte uncompressed point (0x04‖X‖Y) — the exact string
// a browser hands `pushManager.subscribe` as `applicationServerKey` and
// returns as `getKey('p256dh')`. No PEM anywhere: the per-world config blob
// stores what the wire speaks.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace WebPush {

// ── base64url (RFC 4648 §5, unpadded — the Push API's alphabet) ────────────
std::string Base64UrlEncode(const uint8_t* data, size_t len);
std::string Base64UrlEncode(const std::vector<uint8_t>& data);
std::string Base64UrlEncode(const std::string& data);
/// Empty on any character outside the alphabet (padding '=' is tolerated).
std::vector<uint8_t> Base64UrlDecode(const std::string& s);

// ── VAPID keys ─────────────────────────────────────────────────────────────

struct VapidKeyPair {
    std::string publicKeyB64;   ///< 65-byte uncompressed point, base64url
    std::string privateKeyB64;  ///< 32-byte scalar, base64url
};

/// Fresh P-256 pair for a world's config. Ops convenience only — nothing in
/// the send path generates keys.
std::optional<VapidKeyPair> GenerateVapidKeys();

/// The uncompressed public point for a raw-scalar private key, base64url.
/// Empty string on a malformed key. Deterministic, so it pins the whole key
/// register to fixed vectors: if this derives the reference public key from
/// the reference private key, both encodings are the wire's.
std::string DeriveP256PublicKey(const std::string& privateKeyB64url);

// ── VAPID JWT (RFC 8292) ───────────────────────────────────────────────────

/// ES256-signed JWT: header {"alg":"ES256","typ":"JWT"}, claims
/// {"aud":…,"exp":…,"sub":…}. Empty on failure. The signature is the JOSE
/// raw r‖s form (64 bytes), never DER.
std::string SignVapidJwt(const std::string& audience, const std::string& subject,
                         int64_t expiryUnixSeconds,
                         const std::string& privateKeyB64url);

/// Verify a compact ES256 JWT against a base64url uncompressed public key.
/// Used by the tests (an ES256 signature is randomised per RFC 7518, so the
/// fixed vector is a reference-signed token this must accept) and cheap to
/// keep for ops tooling.
bool VerifyEs256Jwt(const std::string& jwt, const std::string& publicKeyB64url);

/// `vapid t=<jwt>, k=<publicKey>` — the Authorization value RFC 8292 §3 asks
/// for. Empty when signing failed.
std::string VapidAuthorizationHeader(const std::string& audience,
                                     const std::string& subject,
                                     int64_t expiryUnixSeconds,
                                     const std::string& privateKeyB64url,
                                     const std::string& publicKeyB64url);

/// The `scheme://host[:port]` origin of a push endpoint URL — RFC 8292's
/// `aud` claim. Empty when the URL has no scheme/host.
std::string EndpointOrigin(const std::string& endpointUrl);

// ── RFC 8291 message encryption ────────────────────────────────────────────

/// The deterministic core: encrypt `plaintext` for a subscription
/// (`uaPublicB64url` = its p256dh point, `authB64url` = its 16-byte auth
/// secret) using a CALLER-SUPPLIED 16-byte salt and ephemeral server private
/// key. Returns the complete `aes128gcm` body (RFC 8188 header ‖ ciphertext ‖
/// tag), empty on any malformed input. rs is fixed at 4096: every payload
/// this lobby sends fits one record.
std::vector<uint8_t> EncryptAes128GcmDeterministic(
    const std::vector<uint8_t>& plaintext,
    const std::string& uaPublicB64url,
    const std::string& authB64url,
    const std::vector<uint8_t>& salt16,
    const std::string& asPrivateB64url);

/// Production wrapper: random salt + fresh ephemeral key per message
/// (RAND_bytes), then the deterministic core.
std::vector<uint8_t> EncryptAes128Gcm(const std::vector<uint8_t>& plaintext,
                                      const std::string& uaPublicB64url,
                                      const std::string& authB64url);

}  // namespace WebPush
