// GW1 de-risk harness (PLAN-game-worker.md Stage 0).
//
// Proves the QUIC / HTTP-3 / WebTransport toolchain links and that the core
// ngtcp2 + ngtcp2_crypto_ossl + nghttp3 + OpenSSL 3.5+ server objects
// construct in this environment — the gating decision for the whole
// game-worker + WebTransport push, before any sim integration.
//
// Build:  cmake -DSPRING_BUILD_QUIC_DERISK=ON ...   then  ./spring-quic-derisk
//
// This is intentionally NOT wired into the build by default; it is a
// standalone link/construct probe, not part of spring-server.

#include <cstdio>

#include <ngtcp2/ngtcp2.h>
#include <ngtcp2/ngtcp2_crypto.h>
#include <ngtcp2/ngtcp2_crypto_ossl.h>
#include <nghttp3/nghttp3.h>
#include <openssl/ssl.h>
#include <openssl/opensslv.h>

int main() {
    printf("OpenSSL  : %s\n", OPENSSL_VERSION_TEXT);
    printf("ngtcp2   : %s\n", ngtcp2_version(0)->version_str);
    printf("nghttp3  : %s\n", nghttp3_version(0)->version_str);

    // ngtcp2 OpenSSL crypto backend init — registers the TLS provider ngtcp2
    // drives during the QUIC handshake.
    if (ngtcp2_crypto_ossl_init() != 0) {
        printf("FAIL: ngtcp2_crypto_ossl_init\n");
        return 1;
    }
    printf("ngtcp2_crypto_ossl_init: ok\n");

    // Server SSL_CTX using OpenSSL's native QUIC TLS API (3.5+). TLS 1.3 only.
    SSL_CTX* ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) {
        printf("FAIL: SSL_CTX_new\n");
        return 1;
    }
    SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION);

    SSL* ssl = SSL_new(ctx);
    if (!ssl) {
        printf("FAIL: SSL_new\n");
        return 1;
    }
    if (ngtcp2_crypto_ossl_configure_server_session(ssl) != 0) {
        printf("FAIL: ngtcp2_crypto_ossl_configure_server_session\n");
        return 1;
    }
    printf("configure_server_session: ok\n");

    // nghttp3 (HTTP/3) layer links and its defaults are sane.
    nghttp3_settings h3s;
    nghttp3_settings_default(&h3s);
    printf("nghttp3 settings default: ok (max_field_section_size=%llu)\n",
           (unsigned long long)h3s.max_field_section_size);

    SSL_free(ssl);
    SSL_CTX_free(ctx);
    printf("ALL OK — QUIC/WebTransport toolchain links and constructs.\n");
    return 0;
}
