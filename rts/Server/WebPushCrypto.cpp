#include "WebPushCrypto.h"

#include <openssl/bn.h>
#include <openssl/core_names.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/obj_mac.h>
#include <openssl/param_build.h>
#include <openssl/rand.h>

#include <cstring>

namespace WebPush {

// ─────────────────────────── base64url ─────────────────────────────────────

namespace {
constexpr const char* kAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

int AlphabetIndex(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}
}  // namespace

std::string Base64UrlEncode(const uint8_t* data, size_t len) {
    std::string out;
    out.reserve((len + 2) / 3 * 4);
    for (size_t i = 0; i < len; i += 3) {
        const unsigned a = data[i];
        const unsigned b = i + 1 < len ? data[i + 1] : 0;
        const unsigned c = i + 2 < len ? data[i + 2] : 0;
        const unsigned triple = (a << 16) | (b << 8) | c;
        out += kAlphabet[(triple >> 18) & 0x3F];
        out += kAlphabet[(triple >> 12) & 0x3F];
        if (i + 1 < len) out += kAlphabet[(triple >> 6) & 0x3F];
        if (i + 2 < len) out += kAlphabet[triple & 0x3F];
    }
    return out;
}

std::string Base64UrlEncode(const std::vector<uint8_t>& data) {
    return Base64UrlEncode(data.data(), data.size());
}

std::string Base64UrlEncode(const std::string& data) {
    return Base64UrlEncode(reinterpret_cast<const uint8_t*>(data.data()), data.size());
}

std::vector<uint8_t> Base64UrlDecode(const std::string& s) {
    std::vector<uint8_t> out;
    unsigned buffer = 0;
    int bits = 0;
    for (const char c : s) {
        if (c == '=') break;  // tolerate padded input
        const int v = AlphabetIndex(c);
        if (v < 0) return {};
        buffer = (buffer << 6) | static_cast<unsigned>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<uint8_t>((buffer >> bits) & 0xFF));
        }
    }
    return out;
}

// ─────────────────────────── P-256 key plumbing ────────────────────────────

namespace {

/// The uncompressed public point for a 32-byte scalar. Empty on failure.
std::vector<uint8_t> PublicPointForScalar(const std::vector<uint8_t>& scalar) {
    std::vector<uint8_t> out;
    if (scalar.size() != 32) return out;
    EC_GROUP* group = EC_GROUP_new_by_curve_name(NID_X9_62_prime256v1);
    BIGNUM* priv = BN_bin2bn(scalar.data(), static_cast<int>(scalar.size()), nullptr);
    EC_POINT* pub = group ? EC_POINT_new(group) : nullptr;
    if (group && priv && pub && !BN_is_zero(priv) &&
        EC_POINT_mul(group, pub, priv, nullptr, nullptr, nullptr) == 1) {
        out.resize(65);
        if (EC_POINT_point2oct(group, pub, POINT_CONVERSION_UNCOMPRESSED,
                               out.data(), out.size(), nullptr) != 65)
            out.clear();
    }
    EC_POINT_free(pub);
    BN_clear_free(priv);
    EC_GROUP_free(group);
    return out;
}

/// Build an EVP_PKEY from a raw scalar (keypair) or a raw point (public only).
EVP_PKEY* MakeP256Key(const std::vector<uint8_t>& scalarOrEmpty,
                      const std::vector<uint8_t>& point65) {
    if (point65.size() != 65 || point65[0] != 0x04) return nullptr;
    EVP_PKEY* pkey = nullptr;
    BIGNUM* priv = nullptr;
    OSSL_PARAM_BLD* bld = OSSL_PARAM_BLD_new();
    if (!bld) return nullptr;
    bool ok = OSSL_PARAM_BLD_push_utf8_string(bld, OSSL_PKEY_PARAM_GROUP_NAME,
                                              "prime256v1", 0) == 1 &&
              OSSL_PARAM_BLD_push_octet_string(bld, OSSL_PKEY_PARAM_PUB_KEY,
                                               point65.data(), point65.size()) == 1;
    if (ok && !scalarOrEmpty.empty()) {
        priv = BN_bin2bn(scalarOrEmpty.data(),
                         static_cast<int>(scalarOrEmpty.size()), nullptr);
        ok = priv != nullptr &&
             OSSL_PARAM_BLD_push_BN(bld, OSSL_PKEY_PARAM_PRIV_KEY, priv) == 1;
    }
    OSSL_PARAM* params = ok ? OSSL_PARAM_BLD_to_param(bld) : nullptr;
    if (params) {
        EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
        if (ctx && EVP_PKEY_fromdata_init(ctx) == 1) {
            const int selection = scalarOrEmpty.empty() ? EVP_PKEY_PUBLIC_KEY
                                                        : EVP_PKEY_KEYPAIR;
            if (EVP_PKEY_fromdata(ctx, &pkey, selection, params) != 1) pkey = nullptr;
        }
        EVP_PKEY_CTX_free(ctx);
    }
    OSSL_PARAM_free(params);
    OSSL_PARAM_BLD_free(bld);
    BN_clear_free(priv);
    return pkey;
}

EVP_PKEY* PrivateKeyFromB64(const std::string& privateKeyB64url) {
    const auto scalar = Base64UrlDecode(privateKeyB64url);
    const auto point = PublicPointForScalar(scalar);
    if (point.empty()) return nullptr;
    return MakeP256Key(scalar, point);
}

EVP_PKEY* PublicKeyFromB64(const std::string& publicKeyB64url) {
    return MakeP256Key({}, Base64UrlDecode(publicKeyB64url));
}

/// ECDH shared secret (32-byte x-coordinate). Empty on failure.
std::vector<uint8_t> Ecdh(EVP_PKEY* mine, EVP_PKEY* theirs) {
    std::vector<uint8_t> out;
    EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new(mine, nullptr);
    size_t len = 0;
    if (ctx && EVP_PKEY_derive_init(ctx) == 1 &&
        EVP_PKEY_derive_set_peer(ctx, theirs) == 1 &&
        EVP_PKEY_derive(ctx, nullptr, &len) == 1) {
        out.resize(len);
        if (EVP_PKEY_derive(ctx, out.data(), &len) != 1) out.clear();
        else out.resize(len);
    }
    EVP_PKEY_CTX_free(ctx);
    return out;
}

/// One HKDF-SHA256 extract+expand. Empty on failure.
std::vector<uint8_t> Hkdf(const std::vector<uint8_t>& salt,
                          const std::vector<uint8_t>& ikm,
                          const std::vector<uint8_t>& info, size_t length) {
    std::vector<uint8_t> out(length);
    EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, nullptr);
    bool ok = ctx && EVP_PKEY_derive_init(ctx) == 1 &&
              EVP_PKEY_CTX_set_hkdf_md(ctx, EVP_sha256()) == 1 &&
              EVP_PKEY_CTX_set1_hkdf_salt(ctx, salt.data(),
                                          static_cast<int>(salt.size())) == 1 &&
              EVP_PKEY_CTX_set1_hkdf_key(ctx, ikm.data(),
                                         static_cast<int>(ikm.size())) == 1 &&
              EVP_PKEY_CTX_add1_hkdf_info(ctx, info.data(),
                                          static_cast<int>(info.size())) == 1;
    size_t len = length;
    if (ok) ok = EVP_PKEY_derive(ctx, out.data(), &len) == 1 && len == length;
    EVP_PKEY_CTX_free(ctx);
    if (!ok) out.clear();
    return out;
}

std::vector<uint8_t> Bytes(const char* s) {
    return std::vector<uint8_t>(s, s + std::strlen(s));
}

}  // namespace

// ─────────────────────────── VAPID keys ────────────────────────────────────

std::optional<VapidKeyPair> GenerateVapidKeys() {
    std::vector<uint8_t> scalar(32);
    // Rejection-sample below the group order: RAND_bytes then retry on the
    // (astronomically unlikely) out-of-range draw — PublicPointForScalar
    // refuses zero, and values >= order are refused by EC_POINT_mul's
    // arithmetic being wrong for them, so just retry until derivation works.
    for (int attempt = 0; attempt < 8; ++attempt) {
        if (RAND_bytes(scalar.data(), static_cast<int>(scalar.size())) != 1)
            return std::nullopt;
        const auto point = PublicPointForScalar(scalar);
        if (point.empty()) continue;
        VapidKeyPair pair;
        pair.privateKeyB64 = Base64UrlEncode(scalar);
        pair.publicKeyB64 = Base64UrlEncode(point);
        return pair;
    }
    return std::nullopt;
}

std::string DeriveP256PublicKey(const std::string& privateKeyB64url) {
    const auto point = PublicPointForScalar(Base64UrlDecode(privateKeyB64url));
    return point.empty() ? std::string() : Base64UrlEncode(point);
}

// ─────────────────────────── ES256 JWT ─────────────────────────────────────

std::string SignVapidJwt(const std::string& audience, const std::string& subject,
                         int64_t expiryUnixSeconds,
                         const std::string& privateKeyB64url) {
    if (audience.empty() || subject.empty()) return {};
    EVP_PKEY* pkey = PrivateKeyFromB64(privateKeyB64url);
    if (!pkey) return {};

    // Field order fixed HERE — the signing input is a byte string, so the
    // serialisation is part of the protocol surface, not a formatting whim.
    const std::string header = R"({"alg":"ES256","typ":"JWT"})";
    std::string claims = "{\"aud\":\"" + audience + "\",\"exp\":" +
                         std::to_string(expiryUnixSeconds) + ",\"sub\":\"" +
                         subject + "\"}";
    const std::string signingInput =
        Base64UrlEncode(header) + "." + Base64UrlEncode(claims);

    std::string jwt;
    EVP_MD_CTX* md = EVP_MD_CTX_new();
    size_t sigLen = 0;
    if (md && EVP_DigestSignInit(md, nullptr, EVP_sha256(), nullptr, pkey) == 1 &&
        EVP_DigestSign(md, nullptr, &sigLen,
                       reinterpret_cast<const uint8_t*>(signingInput.data()),
                       signingInput.size()) == 1) {
        std::vector<uint8_t> der(sigLen);
        if (EVP_DigestSign(md, der.data(), &sigLen,
                           reinterpret_cast<const uint8_t*>(signingInput.data()),
                           signingInput.size()) == 1) {
            der.resize(sigLen);
            // DER → JOSE raw r‖s (RFC 7518 §3.4).
            const uint8_t* p = der.data();
            if (ECDSA_SIG* sig = d2i_ECDSA_SIG(nullptr, &p, static_cast<long>(der.size()))) {
                const BIGNUM* r = nullptr;
                const BIGNUM* s = nullptr;
                ECDSA_SIG_get0(sig, &r, &s);
                uint8_t raw[64];
                if (BN_bn2binpad(r, raw, 32) == 32 &&
                    BN_bn2binpad(s, raw + 32, 32) == 32)
                    jwt = signingInput + "." + Base64UrlEncode(raw, sizeof(raw));
                ECDSA_SIG_free(sig);
            }
        }
    }
    EVP_MD_CTX_free(md);
    EVP_PKEY_free(pkey);
    return jwt;
}

bool VerifyEs256Jwt(const std::string& jwt, const std::string& publicKeyB64url) {
    const size_t dot2 = jwt.find_last_of('.');
    if (dot2 == std::string::npos || dot2 == 0 || dot2 + 1 >= jwt.size()) return false;
    const std::string signingInput = jwt.substr(0, dot2);
    if (signingInput.find('.') == std::string::npos) return false;
    const auto raw = Base64UrlDecode(jwt.substr(dot2 + 1));
    if (raw.size() != 64) return false;

    EVP_PKEY* pkey = PublicKeyFromB64(publicKeyB64url);
    if (!pkey) return false;

    bool ok = false;
    // JOSE raw r‖s → DER for OpenSSL's verifier.
    ECDSA_SIG* sig = ECDSA_SIG_new();
    BIGNUM* r = BN_bin2bn(raw.data(), 32, nullptr);
    BIGNUM* s = BN_bin2bn(raw.data() + 32, 32, nullptr);
    if (sig && r && s && ECDSA_SIG_set0(sig, r, s) == 1) {
        r = nullptr;  // owned by sig now
        s = nullptr;
        uint8_t* der = nullptr;
        const int derLen = i2d_ECDSA_SIG(sig, &der);
        if (derLen > 0) {
            EVP_MD_CTX* md = EVP_MD_CTX_new();
            ok = md &&
                 EVP_DigestVerifyInit(md, nullptr, EVP_sha256(), nullptr, pkey) == 1 &&
                 EVP_DigestVerify(md, der, static_cast<size_t>(derLen),
                                  reinterpret_cast<const uint8_t*>(signingInput.data()),
                                  signingInput.size()) == 1;
            EVP_MD_CTX_free(md);
        }
        OPENSSL_free(der);
    }
    ECDSA_SIG_free(sig);
    BN_free(r);
    BN_free(s);
    EVP_PKEY_free(pkey);
    return ok;
}

std::string VapidAuthorizationHeader(const std::string& audience,
                                     const std::string& subject,
                                     int64_t expiryUnixSeconds,
                                     const std::string& privateKeyB64url,
                                     const std::string& publicKeyB64url) {
    const std::string jwt =
        SignVapidJwt(audience, subject, expiryUnixSeconds, privateKeyB64url);
    if (jwt.empty() || publicKeyB64url.empty()) return {};
    return "vapid t=" + jwt + ", k=" + publicKeyB64url;
}

std::string EndpointOrigin(const std::string& endpointUrl) {
    const size_t schemeAt = endpointUrl.find("://");
    if (schemeAt == std::string::npos) return {};
    const size_t hostFrom = schemeAt + 3;
    if (hostFrom >= endpointUrl.size()) return {};
    const size_t pathAt = endpointUrl.find('/', hostFrom);
    return endpointUrl.substr(0, pathAt == std::string::npos ? endpointUrl.size()
                                                             : pathAt);
}

// ─────────────────────────── RFC 8291 encryption ───────────────────────────

std::vector<uint8_t> EncryptAes128GcmDeterministic(
    const std::vector<uint8_t>& plaintext,
    const std::string& uaPublicB64url,
    const std::string& authB64url,
    const std::vector<uint8_t>& salt16,
    const std::string& asPrivateB64url) {
    std::vector<uint8_t> out;
    const auto uaPublic = Base64UrlDecode(uaPublicB64url);
    const auto auth = Base64UrlDecode(authB64url);
    const auto asScalar = Base64UrlDecode(asPrivateB64url);
    const auto asPublic = PublicPointForScalar(asScalar);
    if (uaPublic.size() != 65 || auth.size() != 16 || salt16.size() != 16 ||
        asPublic.empty())
        return out;

    EVP_PKEY* asKey = MakeP256Key(asScalar, asPublic);
    EVP_PKEY* uaKey = MakeP256Key({}, uaPublic);
    std::vector<uint8_t> ecdh;
    if (asKey && uaKey) ecdh = Ecdh(asKey, uaKey);
    EVP_PKEY_free(asKey);
    EVP_PKEY_free(uaKey);
    if (ecdh.size() != 32) return out;

    // RFC 8291 §3.3-3.4: two chained HKDFs. First the auth secret binds the
    // ECDH output to this subscription; then the salt derives the content
    // key + nonce (RFC 8188 §2).
    std::vector<uint8_t> keyInfo = Bytes("WebPush: info");
    keyInfo.push_back(0x00);
    keyInfo.insert(keyInfo.end(), uaPublic.begin(), uaPublic.end());
    keyInfo.insert(keyInfo.end(), asPublic.begin(), asPublic.end());
    const auto ikm = Hkdf(auth, ecdh, keyInfo, 32);

    std::vector<uint8_t> cekInfo = Bytes("Content-Encoding: aes128gcm");
    cekInfo.push_back(0x00);
    std::vector<uint8_t> nonceInfo = Bytes("Content-Encoding: nonce");
    nonceInfo.push_back(0x00);
    const auto cek = Hkdf(salt16, ikm, cekInfo, 16);
    const auto nonce = Hkdf(salt16, ikm, nonceInfo, 12);
    if (ikm.empty() || cek.empty() || nonce.empty()) return out;

    // One record: plaintext ‖ 0x02 (the final-record delimiter), sealed.
    std::vector<uint8_t> record = plaintext;
    record.push_back(0x02);
    std::vector<uint8_t> sealed(record.size() + 16);
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    int len = 0;
    int total = 0;
    bool ok = ctx &&
              EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), nullptr, nullptr, nullptr) == 1 &&
              EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, nullptr) == 1 &&
              EVP_EncryptInit_ex(ctx, nullptr, nullptr, cek.data(), nonce.data()) == 1 &&
              EVP_EncryptUpdate(ctx, sealed.data(), &len, record.data(),
                                static_cast<int>(record.size())) == 1;
    total = len;
    ok = ok && EVP_EncryptFinal_ex(ctx, sealed.data() + total, &len) == 1;
    total += len;
    ok = ok && EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16,
                                   sealed.data() + total) == 1;
    total += 16;
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) return out;
    sealed.resize(total);

    // RFC 8188 §2.1 header: salt(16) ‖ rs(4, BE) ‖ idlen(1) ‖ keyid(65).
    out = salt16;
    const uint32_t rs = 4096;
    out.push_back(static_cast<uint8_t>((rs >> 24) & 0xFF));
    out.push_back(static_cast<uint8_t>((rs >> 16) & 0xFF));
    out.push_back(static_cast<uint8_t>((rs >> 8) & 0xFF));
    out.push_back(static_cast<uint8_t>(rs & 0xFF));
    out.push_back(static_cast<uint8_t>(asPublic.size()));
    out.insert(out.end(), asPublic.begin(), asPublic.end());
    out.insert(out.end(), sealed.begin(), sealed.end());
    return out;
}

std::vector<uint8_t> EncryptAes128Gcm(const std::vector<uint8_t>& plaintext,
                                      const std::string& uaPublicB64url,
                                      const std::string& authB64url) {
    std::vector<uint8_t> salt(16);
    if (RAND_bytes(salt.data(), static_cast<int>(salt.size())) != 1) return {};
    const auto ephemeral = GenerateVapidKeys();  // any fresh P-256 pair
    if (!ephemeral) return {};
    return EncryptAes128GcmDeterministic(plaintext, uaPublicB64url, authB64url,
                                         salt, ephemeral->privateKeyB64);
}

}  // namespace WebPush
