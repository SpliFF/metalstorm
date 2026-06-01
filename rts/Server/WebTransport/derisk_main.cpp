// GW1 de-risk harness + WebTransport echo server (PLAN-game-worker.md Stage 0).
//
// Two modes:
//   (default)  link/construct probe — proves the QUIC/HTTP-3/WebTransport
//              toolchain links and the core ngtcp2 + ngtcp2_crypto_ossl +
//              nghttp3 + OpenSSL 3.5+ server objects construct. Prints "ALL OK".
//   serve [port]  run a real WebTransportServer in echo mode (every application
//                 message is echoed back to the sender on the same class). This
//                 is the GW1 exit gate: drive it from Chrome with
//                 `new WebTransport(url, {serverCertificateHashes:[CertHash]})`.
//
// Build:  cmake -DSPRING_BUILD_QUIC_DERISK=ON ...   then  ./spring-quic-derisk [serve [port]]

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <chrono>
#include <thread>

#include <ngtcp2/ngtcp2.h>
#include <ngtcp2/ngtcp2_crypto.h>
#include <ngtcp2/ngtcp2_crypto_ossl.h>
#include <nghttp3/nghttp3.h>
#include <openssl/ssl.h>
#include <openssl/opensslv.h>

#include "WebTransportServer.h"

static int RunProbe() {
    printf("OpenSSL  : %s\n", OPENSSL_VERSION_TEXT);
    printf("ngtcp2   : %s\n", ngtcp2_version(0)->version_str);
    printf("nghttp3  : %s\n", nghttp3_version(0)->version_str);

    if (ngtcp2_crypto_ossl_init() != 0) {
        printf("FAIL: ngtcp2_crypto_ossl_init\n");
        return 1;
    }
    printf("ngtcp2_crypto_ossl_init: ok\n");

    SSL_CTX* ctx = SSL_CTX_new(TLS_server_method());
    if (!ctx) { printf("FAIL: SSL_CTX_new\n"); return 1; }
    SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(ctx, TLS1_3_VERSION);

    SSL* ssl = SSL_new(ctx);
    if (!ssl) { printf("FAIL: SSL_new\n"); return 1; }
    if (ngtcp2_crypto_ossl_configure_server_session(ssl) != 0) {
        printf("FAIL: ngtcp2_crypto_ossl_configure_server_session\n");
        return 1;
    }
    printf("configure_server_session: ok\n");

    nghttp3_settings h3s;
    nghttp3_settings_default(&h3s);
    printf("nghttp3 settings default: ok (max_field_section_size=%llu)\n",
           (unsigned long long)h3s.max_field_section_size);

    SSL_free(ssl);
    SSL_CTX_free(ctx);
    printf("ALL OK — QUIC/WebTransport toolchain links and constructs.\n");
    return 0;
}

static int RunEcho(int port) {
    WebTransportServer server;
    server.SetEchoMode(true);
    if (!server.Start(port)) {
        printf("FAIL: WebTransportServer.Start(%d)\n", port);
        return 1;
    }
    printf("\n=== WebTransport echo server ===\n");
    printf("url       : https://localhost:%d/\n", server.Port());
    printf("certHash  : %s\n", server.CertHash().c_str());
    printf("\nDrive from Chrome:\n");
    printf("  const wt = new WebTransport('https://localhost:%d/', {\n", server.Port());
    printf("    serverCertificateHashes: [{ algorithm:'sha-256',\n");
    printf("      value: Uint8Array.from('%s'.match(/../g).map(h=>parseInt(h,16))) }]});\n",
           server.CertHash().c_str());
    printf("\nCtrl-C to stop. Echoing all messages.\n\n");
    fflush(stdout);

    for (;;) {
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 2 && std::strcmp(argv[1], "serve") == 0) {
        int port = (argc >= 3) ? std::atoi(argv[2]) : 4433;
        return RunEcho(port);
    }
    return RunProbe();
}
