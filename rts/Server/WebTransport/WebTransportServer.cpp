// WebTransportServer — QUIC server core (PLAN-game-worker.md GW1).
//
// This file implements the QUIC transport layer: a UDP socket, the ngtcp2
// server connection lifecycle (accept → handshake via OpenSSL/ngtcp2_crypto_ossl
// → stream I/O → close), and the WebTransportServer seam (SendStream/
// BroadcastStream/DrainInbound/DrainDisconnects). It uses an ephemeral
// self-signed ECDSA cert in dev, exposing its SHA-256 via CertHash() for the
// client's serverCertificateHashes pin.
//
// ────────────────────────────────────────────────────────────────────────────
// LAYERING — what this file does NOT yet do (the next GW1 increment):
//
//   A browser's `new WebTransport(url)` speaks **HTTP/3 + the WebTransport
//   draft** over QUIC, not raw QUIC streams. That layer is:
//     1. nghttp3 bound to the QUIC streams (control + qpack enc/dec streams),
//        SETTINGS with enable_connect_protocol + h3_datagram + WT max-sessions.
//     2. Accept the extended CONNECT request (`:method=CONNECT`,
//        `:protocol=webtransport`), respond `:status 200` → the request stream
//        becomes the WebTransport session.
//     3. WebTransport stream framing: uni streams prefixed with the
//        WT_UNI_STREAM type (0x54) + session id varint; bidi streams with the
//        WT_BIDI signal (0x41) + session id; H3 datagrams with the
//        quarter-stream-id prefix.
//   Until that lands, this server establishes QUIC connections and moves bytes
//   on raw QUIC streams (correct for a raw-QUIC peer / the C++ echo de-risk),
//   but a browser cannot complete the WebTransport handshake. The H3/WT demux
//   is marked `// TODO(GW1-H3)` at the seams it plugs into.
// ────────────────────────────────────────────────────────────────────────────

#include "WebTransportServer.h"
#include "Server/NetworkServer.h" // InboundMessage

#include <ngtcp2/ngtcp2.h>
#include <ngtcp2/ngtcp2_crypto.h>
#include <ngtcp2/ngtcp2_crypto_ossl.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/pem.h>
#include <openssl/rand.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kMaxCidLen = NGTCP2_MAX_CIDLEN;
constexpr size_t kMaxUdpPayload = 1452; // conservative IPv4 path MTU

ngtcp2_tstamp NowNs() {
    using namespace std::chrono;
    return (ngtcp2_tstamp)duration_cast<nanoseconds>(
               steady_clock::now().time_since_epoch())
        .count();
}

// Lower-case hex of a byte buffer.
std::string ToHex(const uint8_t* p, size_t n) {
    static const char* h = "0123456789abcdef";
    std::string s;
    s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) {
        s.push_back(h[p[i] >> 4]);
        s.push_back(h[p[i] & 0xf]);
    }
    return s;
}

// A connection-id key usable in an unordered_map.
struct CidKey {
    uint8_t data[kMaxCidLen];
    size_t len;
    bool operator==(const CidKey& o) const {
        return len == o.len && std::memcmp(data, o.data, len) == 0;
    }
};
struct CidKeyHash {
    size_t operator()(const CidKey& k) const {
        size_t h = 1469598103934665603ull;
        for (size_t i = 0; i < k.len; i++) { h ^= k.data[i]; h *= 1099511628211ull; }
        return h;
    }
};
CidKey MakeCidKey(const uint8_t* d, size_t n) {
    CidKey k{};
    k.len = n > kMaxCidLen ? kMaxCidLen : n;
    std::memcpy(k.data, d, k.len);
    return k;
}

} // namespace

// ───────────────────────────── per-connection state ─────────────────────────

struct WtConn {
    ClientID clientId = 0;
    ngtcp2_conn* conn = nullptr;
    ngtcp2_crypto_conn_ref connRef{};
    SSL* ssl = nullptr;
    ngtcp2_crypto_ossl_ctx* osslCtx = nullptr;
    sockaddr_storage remote{};
    socklen_t remoteLen = 0;
    bool handshakeDone = false;
    bool closed = false;

    // Inbound reassembly: bytes accumulated per stream until FIN, then pushed
    // to the server inbound queue. (At the QUIC-core layer one message ==
    // one stream + FIN; the H3/WT layer replaces this — TODO(GW1-H3).)
    std::unordered_map<int64_t, std::vector<uint8_t>> streamRx;

    // Outbound: messages queued by SendStream, each sent on a fresh uni stream.
    std::deque<std::vector<uint8_t>> txQueue;
    // The single uni stream currently being drained (-1 = none open).
    int64_t txStream = -1;
    size_t txOffset = 0;
};

// ───────────────────────────────── Impl ─────────────────────────────────────

struct WebTransportServerImpl {
    int fd = -1;
    int port = 0;
    std::thread thread;
    std::atomic<bool> running{false};

    SSL_CTX* sslCtx = nullptr;
    std::string certHashHex;

    uint32_t nextClientId = 1;

    // clientId → conn, plus cid/addr routing tables (all touched only on the
    // network thread except the maps the seam reads under mutex).
    std::unordered_map<ClientID, WtConn*> conns;
    std::unordered_map<CidKey, ClientID, CidKeyHash> cidToClient;

    std::mutex inboundMutex;
    std::vector<InboundMessage> inbound;
    std::mutex disconnectMutex;
    std::vector<ClientID> disconnects;

    // SendStream / BroadcastStream cross the thread boundary into here.
    std::mutex txMutex;
    struct PendingTx { ClientID clientId; bool broadcast; std::vector<uint8_t> data; };
    std::vector<PendingTx> pendingTx;

    bool GenerateSelfSigned();
    bool SetupTls(const std::string& certPem, const std::string& keyPem);
    void Run();
    WtConn* AcceptConn(const ngtcp2_pkt_hd& hd, const sockaddr* sa, socklen_t salen,
                       const ngtcp2_path& path);
    void DrainPendingTx();
    void FlushConn(WtConn* c);
    void CloseConn(WtConn* c);
};

// ──────────────────────────── ngtcp2 callbacks ──────────────────────────────

static ngtcp2_conn* GetConn(ngtcp2_crypto_conn_ref* ref) {
    return static_cast<WtConn*>(ref->user_data)->conn;
}

static void RandCb(uint8_t* dest, size_t destlen, const ngtcp2_rand_ctx*) {
    RAND_bytes(dest, (int)destlen);
}

static int GetNewCidCb(ngtcp2_conn* /*conn*/, ngtcp2_cid* cid, uint8_t* token,
                       size_t cidlen, void* /*user_data*/) {
    if (RAND_bytes(cid->data, (int)cidlen) != 1) return NGTCP2_ERR_CALLBACK_FAILURE;
    cid->datalen = cidlen;
    if (RAND_bytes(token, NGTCP2_STATELESS_RESET_TOKENLEN) != 1)
        return NGTCP2_ERR_CALLBACK_FAILURE;
    // TODO(GW1-H3): register cid in the routing table so migrated packets route.
    return 0;
}

static int HandshakeCompletedCb(ngtcp2_conn* /*conn*/, void* user_data) {
    static_cast<WtConn*>(user_data)->handshakeDone = true;
    // TODO(GW1-H3): bind nghttp3 conn here and open the H3 control/qpack streams.
    return 0;
}

static int RecvStreamDataCb(ngtcp2_conn* /*conn*/, uint32_t flags, int64_t stream_id,
                            uint64_t /*offset*/, const uint8_t* data, size_t datalen,
                            void* user_data, void* /*stream_user_data*/) {
    auto* c = static_cast<WtConn*>(user_data);
    auto& buf = c->streamRx[stream_id];
    buf.insert(buf.end(), data, data + datalen);
    if (flags & NGTCP2_STREAM_DATA_FLAG_FIN) {
        // TODO(GW1-H3): route through nghttp3 + WebTransport stream demux. At the
        // QUIC-core layer, one stream + FIN == one application message; surface it
        // to the sim's inbound queue via the network thread's owning Impl.
        extern void WtConn_DeliverInbound(WtConn*, std::vector<uint8_t> &&);
        WtConn_DeliverInbound(c, std::move(buf));
        c->streamRx.erase(stream_id);
    }
    return 0;
}

static int StreamCloseCb(ngtcp2_conn* /*conn*/, uint32_t /*flags*/, int64_t stream_id,
                         uint64_t /*app_error_code*/, void* user_data,
                         void* /*stream_user_data*/) {
    static_cast<WtConn*>(user_data)->streamRx.erase(stream_id);
    return 0;
}

static int RecvDatagramCb(ngtcp2_conn* /*conn*/, uint32_t /*flags*/, const uint8_t* data,
                          size_t datalen, void* user_data) {
    // TODO(GW1-H3): H3 datagram → WebTransport datagram (strip quarter-stream-id).
    extern void WtConn_DeliverInbound(WtConn*, std::vector<uint8_t>&&);
    std::vector<uint8_t> msg(data, data + datalen);
    WtConn_DeliverInbound(static_cast<WtConn*>(user_data), std::move(msg));
    return 0;
}

// Bridge from the pure ngtcp2 callbacks back to the owning Impl. Set for the
// duration of a Run() iteration so callbacks can deliver inbound messages.
static thread_local WebTransportServerImpl* tlsImpl = nullptr;

void WtConn_DeliverInbound(WtConn* c, std::vector<uint8_t>&& msg) {
    if (!tlsImpl || msg.empty()) return;
    std::lock_guard<std::mutex> lk(tlsImpl->inboundMutex);
    tlsImpl->inbound.push_back(InboundMessage{c->clientId, std::move(msg)});
}

// ────────────────────────────── TLS / certs ─────────────────────────────────

bool WebTransportServerImpl::GenerateSelfSigned() {
    EVP_PKEY* pkey = EVP_EC_gen("P-256");
    if (!pkey) return false;
    X509* x509 = X509_new();
    if (!x509) { EVP_PKEY_free(pkey); return false; }
    ASN1_INTEGER_set(X509_get_serialNumber(x509), 1);
    X509_gmtime_adj(X509_getm_notBefore(x509), 0);
    X509_gmtime_adj(X509_getm_notAfter(x509), 60L * 60 * 24 * 14); // 14 days
    X509_set_pubkey(x509, pkey);
    X509_NAME* name = X509_get_subject_name(x509);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                               (const unsigned char*)"spring-server", -1, -1, 0);
    X509_set_issuer_name(x509, name);
    if (!X509_sign(x509, pkey, EVP_sha256())) {
        X509_free(x509); EVP_PKEY_free(pkey); return false;
    }
    // SHA-256 of the DER cert → certHashHex (serverCertificateHashes pin).
    unsigned char* der = nullptr;
    int derLen = i2d_X509(x509, &der);
    if (derLen > 0 && der) {
        unsigned char md[EVP_MAX_MD_SIZE];
        unsigned int mdLen = 0;
        EVP_Digest(der, derLen, md, &mdLen, EVP_sha256(), nullptr);
        certHashHex = ToHex(md, mdLen);
        OPENSSL_free(der);
    }
    bool ok = SSL_CTX_use_certificate(sslCtx, x509) == 1 &&
              SSL_CTX_use_PrivateKey(sslCtx, pkey) == 1;
    X509_free(x509);
    EVP_PKEY_free(pkey);
    return ok;
}

static int AlpnSelectCb(SSL*, const unsigned char** out, unsigned char* outlen,
                        const unsigned char* in, unsigned int inlen, void*) {
    // Select "h3" (WebTransport runs over HTTP/3).
    static const unsigned char h3[] = {2, 'h', '3'};
    if (SSL_select_next_proto((unsigned char**)out, outlen, h3, sizeof(h3), in, inlen) !=
        OPENSSL_NPN_NEGOTIATED) {
        return SSL_TLSEXT_ERR_ALERT_FATAL;
    }
    return SSL_TLSEXT_ERR_OK;
}

bool WebTransportServerImpl::SetupTls(const std::string& certPem, const std::string& keyPem) {
    if (ngtcp2_crypto_ossl_init() != 0) return false;
    sslCtx = SSL_CTX_new(TLS_server_method());
    if (!sslCtx) return false;
    SSL_CTX_set_min_proto_version(sslCtx, TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(sslCtx, TLS1_3_VERSION);
    SSL_CTX_set_alpn_select_cb(sslCtx, AlpnSelectCb, nullptr);
    if (!certPem.empty() && !keyPem.empty()) {
        BIO* cbio = BIO_new_mem_buf(certPem.data(), (int)certPem.size());
        X509* cert = PEM_read_bio_X509(cbio, nullptr, nullptr, nullptr);
        BIO_free(cbio);
        BIO* kbio = BIO_new_mem_buf(keyPem.data(), (int)keyPem.size());
        EVP_PKEY* key = PEM_read_bio_PrivateKey(kbio, nullptr, nullptr, nullptr);
        BIO_free(kbio);
        bool ok = cert && key && SSL_CTX_use_certificate(sslCtx, cert) == 1 &&
                  SSL_CTX_use_PrivateKey(sslCtx, key) == 1;
        if (cert) {
            unsigned char* der = nullptr;
            int derLen = i2d_X509(cert, &der);
            if (derLen > 0 && der) {
                unsigned char md[EVP_MAX_MD_SIZE];
                unsigned int mdLen = 0;
                EVP_Digest(der, derLen, md, &mdLen, EVP_sha256(), nullptr);
                certHashHex = ToHex(md, mdLen);
                OPENSSL_free(der);
            }
            X509_free(cert);
        }
        if (key) EVP_PKEY_free(key);
        return ok;
    }
    return GenerateSelfSigned();
}

// ─────────────────────────── connection accept ──────────────────────────────

WtConn* WebTransportServerImpl::AcceptConn(const ngtcp2_pkt_hd& hd, const sockaddr* sa,
                                             socklen_t salen, const ngtcp2_path& path) {
    auto* c = new WtConn();
    c->clientId = nextClientId++;
    std::memcpy(&c->remote, sa, salen);
    c->remoteLen = salen;
    c->connRef.get_conn = GetConn;
    c->connRef.user_data = c;

    if (ngtcp2_crypto_ossl_ctx_new(&c->osslCtx, nullptr) != 0) { delete c; return nullptr; }
    c->ssl = SSL_new(sslCtx);
    if (!c->ssl) { ngtcp2_crypto_ossl_ctx_del(c->osslCtx); delete c; return nullptr; }
    SSL_set_app_data(c->ssl, &c->connRef);
    SSL_set_accept_state(c->ssl);
    ngtcp2_crypto_ossl_ctx_set_ssl(c->osslCtx, c->ssl);
    if (ngtcp2_crypto_ossl_configure_server_session(c->ssl) != 0) {
        SSL_free(c->ssl); ngtcp2_crypto_ossl_ctx_del(c->osslCtx); delete c; return nullptr;
    }

    ngtcp2_callbacks cb{};
    cb.recv_client_initial = ngtcp2_crypto_recv_client_initial_cb;
    cb.recv_crypto_data = ngtcp2_crypto_recv_crypto_data_cb;
    cb.encrypt = ngtcp2_crypto_encrypt_cb;
    cb.decrypt = ngtcp2_crypto_decrypt_cb;
    cb.hp_mask = ngtcp2_crypto_hp_mask_cb;
    cb.update_key = ngtcp2_crypto_update_key_cb;
    cb.delete_crypto_aead_ctx = ngtcp2_crypto_delete_crypto_aead_ctx_cb;
    cb.delete_crypto_cipher_ctx = ngtcp2_crypto_delete_crypto_cipher_ctx_cb;
    cb.get_path_challenge_data = ngtcp2_crypto_get_path_challenge_data_cb;
    cb.version_negotiation = ngtcp2_crypto_version_negotiation_cb;
    cb.rand = RandCb;
    cb.get_new_connection_id = GetNewCidCb;
    cb.handshake_completed = HandshakeCompletedCb;
    cb.recv_stream_data = RecvStreamDataCb;
    cb.stream_close = StreamCloseCb;
    cb.recv_datagram = RecvDatagramCb;

    // Our source CID (random); the client's source CID (hd.scid) becomes our DCID.
    ngtcp2_cid scid{};
    scid.datalen = 18;
    RAND_bytes(scid.data, (int)scid.datalen);

    ngtcp2_settings settings;
    ngtcp2_settings_default(&settings);
    settings.initial_ts = NowNs();

    ngtcp2_transport_params params;
    ngtcp2_transport_params_default(&params);
    params.initial_max_streams_bidi = 128;
    params.initial_max_streams_uni = 128;
    params.initial_max_stream_data_bidi_local = 512 * 1024;
    params.initial_max_stream_data_bidi_remote = 512 * 1024;
    params.initial_max_stream_data_uni = 512 * 1024;
    params.initial_max_data = 4 * 1024 * 1024;
    params.max_datagram_frame_size = 1200; // enable QUIC datagrams (WT datagrams)
    params.original_dcid = hd.dcid;
    params.original_dcid_present = 1;

    int rv = ngtcp2_conn_server_new(&c->conn, &hd.scid, &scid, &path,
                                    NGTCP2_PROTO_VER_V1, &cb, &settings, &params,
                                    nullptr, c);
    if (rv != 0) {
        SSL_free(c->ssl); ngtcp2_crypto_ossl_ctx_del(c->osslCtx); delete c; return nullptr;
    }
    ngtcp2_conn_set_tls_native_handle(c->conn, c->osslCtx);

    conns[c->clientId] = c;
    cidToClient[MakeCidKey(scid.data, scid.datalen)] = c->clientId;
    cidToClient[MakeCidKey(hd.dcid.data, hd.dcid.datalen)] = c->clientId;
    return c;
}

void WebTransportServerImpl::CloseConn(WtConn* c) {
    if (c->closed) return;
    c->closed = true;
    {
        std::lock_guard<std::mutex> lk(disconnectMutex);
        disconnects.push_back(c->clientId);
    }
    conns.erase(c->clientId);
    for (auto it = cidToClient.begin(); it != cidToClient.end();) {
        if (it->second == c->clientId) it = cidToClient.erase(it); else ++it;
    }
    if (c->conn) ngtcp2_conn_del(c->conn);
    if (c->ssl) SSL_free(c->ssl);
    if (c->osslCtx) ngtcp2_crypto_ossl_ctx_del(c->osslCtx);
    delete c;
}

// ───────────────────────── outbound (seam → streams) ────────────────────────

void WebTransportServerImpl::DrainPendingTx() {
    std::vector<PendingTx> batch;
    {
        std::lock_guard<std::mutex> lk(txMutex);
        batch.swap(pendingTx);
    }
    for (auto& tx : batch) {
        if (tx.broadcast) {
            for (auto& [id, c] : conns) c->txQueue.push_back(tx.data);
        } else {
            auto it = conns.find(tx.clientId);
            if (it != conns.end()) it->second->txQueue.push_back(std::move(tx.data));
        }
    }
}

void WebTransportServerImpl::FlushConn(WtConn* c) {
    uint8_t out[kMaxUdpPayload];
    ngtcp2_path_storage ps;
    ngtcp2_path_storage_zero(&ps);
    ngtcp2_pkt_info pi{};

    for (;;) {
        // Open a uni stream for the next queued message if none in flight.
        // TODO(GW1-H3): prefix with the WebTransport uni-stream type + session id.
        ngtcp2_vec datav{};
        int64_t streamId = -1;
        uint32_t flags = NGTCP2_WRITE_STREAM_FLAG_NONE;
        if (c->txStream < 0 && !c->txQueue.empty() && c->handshakeDone) {
            int64_t sid;
            if (ngtcp2_conn_open_uni_stream(c->conn, &sid, nullptr) == 0) {
                c->txStream = sid;
                c->txOffset = 0;
            }
        }
        if (c->txStream >= 0 && !c->txQueue.empty()) {
            auto& msg = c->txQueue.front();
            datav.base = msg.data() + c->txOffset;
            datav.len = msg.size() - c->txOffset;
            streamId = c->txStream;
            flags |= NGTCP2_WRITE_STREAM_FLAG_FIN;
        }

        ngtcp2_ssize datalen = 0;
        ngtcp2_ssize n = ngtcp2_conn_writev_stream(
            c->conn, &ps.path, &pi, out, sizeof(out), &datalen, flags, streamId,
            streamId >= 0 ? &datav : nullptr, streamId >= 0 ? 1 : 0, NowNs());
        if (n < 0) {
            if (n == NGTCP2_ERR_WRITE_MORE) {
                if (datalen > 0 && streamId >= 0) {
                    c->txOffset += (size_t)datalen;
                    if (c->txOffset >= c->txQueue.front().size()) {
                        c->txQueue.pop_front();
                        c->txStream = -1;
                        c->txOffset = 0;
                    }
                }
                continue;
            }
            CloseConn(c);
            return;
        }
        if (datalen > 0 && streamId >= 0) {
            c->txOffset += (size_t)datalen;
            if (c->txOffset >= c->txQueue.front().size()) {
                c->txQueue.pop_front();
                c->txStream = -1;
                c->txOffset = 0;
            }
        }
        if (n == 0) break; // nothing more to write
        sendto(fd, out, (size_t)n, 0, (sockaddr*)&c->remote, c->remoteLen);
    }
}

// ───────────────────────────── network thread ───────────────────────────────

void WebTransportServerImpl::Run() {
    tlsImpl = this;
    uint8_t buf[2048];
    while (running.load()) {
        // Compute poll timeout from the nearest connection expiry.
        ngtcp2_tstamp now = NowNs();
        ngtcp2_tstamp earliest = UINT64_MAX;
        for (auto& [id, c] : conns) {
            ngtcp2_tstamp e = ngtcp2_conn_get_expiry(c->conn);
            if (e < earliest) earliest = e;
        }
        int timeoutMs = 50;
        if (earliest != UINT64_MAX) {
            timeoutMs = earliest <= now ? 0 : (int)((earliest - now) / 1000000ull);
            if (timeoutMs > 50) timeoutMs = 50;
        }

        pollfd pfd{fd, POLLIN, 0};
        int pr = poll(&pfd, 1, timeoutMs);
        if (!running.load()) break;

        if (pr > 0 && (pfd.revents & POLLIN)) {
            for (;;) {
                sockaddr_storage sa{};
                socklen_t salen = sizeof(sa);
                ssize_t rd = recvfrom(fd, buf, sizeof(buf), 0, (sockaddr*)&sa, &salen);
                if (rd <= 0) break;

                ngtcp2_version_cid vc;
                int rv = ngtcp2_pkt_decode_version_cid(&vc, buf, (size_t)rd, kMaxCidLen);
                if (rv != 0) continue;

                ClientID target = 0;
                auto cit = cidToClient.find(MakeCidKey(vc.dcid, vc.dcidlen));
                if (cit != cidToClient.end()) target = cit->second;

                ngtcp2_path_storage ps;
                ngtcp2_path_storage_zero(&ps);
                sockaddr_storage local{};
                socklen_t locallen = sizeof(local);
                getsockname(fd, (sockaddr*)&local, &locallen);
                ngtcp2_addr_init(&ps.path.local, (sockaddr*)&local, locallen);
                ngtcp2_addr_init(&ps.path.remote, (sockaddr*)&sa, salen);

                WtConn* c = nullptr;
                if (target) {
                    auto it = conns.find(target);
                    if (it != conns.end()) c = it->second;
                }
                if (!c) {
                    // New connection — must be a client Initial.
                    ngtcp2_pkt_hd hd;
                    if (ngtcp2_accept(&hd, buf, (size_t)rd) != 0) continue;
                    c = AcceptConn(hd, (sockaddr*)&sa, salen, ps.path);
                    if (!c) continue;
                }

                ngtcp2_pkt_info pi{};
                int rrv = ngtcp2_conn_read_pkt(c->conn, &ps.path, &pi, buf, (size_t)rd, NowNs());
                if (rrv != 0) {
                    if (rrv == NGTCP2_ERR_DRAINING || rrv == NGTCP2_ERR_DROP_CONN) {
                        CloseConn(c);
                    }
                    continue;
                }
            }
        }

        DrainPendingTx();
        // Write any pending packets + handle timers per connection.
        std::vector<WtConn*> snapshot;
        snapshot.reserve(conns.size());
        for (auto& [id, c] : conns) snapshot.push_back(c);
        for (WtConn* c : snapshot) {
            if (c->closed) continue;
            if (ngtcp2_conn_get_expiry(c->conn) <= NowNs()) {
                if (ngtcp2_conn_handle_expiry(c->conn, NowNs()) != 0) { CloseConn(c); continue; }
            }
            FlushConn(c);
        }
    }
    tlsImpl = nullptr;
}

// ──────────────────────────────── public seam ───────────────────────────────

WebTransportServer::WebTransportServer() : impl_(std::make_unique<WebTransportServerImpl>()) {}
WebTransportServer::~WebTransportServer() { Shutdown(); }

bool WebTransportServer::Start(int port, const std::string& certPem, const std::string& keyPem) {
    if (!impl_->SetupTls(certPem, keyPem)) {
        std::fprintf(stderr, "[webtransport] TLS setup failed\n");
        return false;
    }
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return false;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);
    if (bind(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
        std::fprintf(stderr, "[webtransport] bind(:%d) failed\n", port);
        close(fd);
        return false;
    }
    impl_->fd = fd;
    impl_->port = port;
    impl_->running.store(true);
    impl_->thread = std::thread([this] { impl_->Run(); });
    std::fprintf(stderr, "[webtransport] QUIC listening on udp/:%d (certhash=%s)\n",
                 port, impl_->certHashHex.c_str());
    return true;
}

std::string WebTransportServer::CertHash() const { return impl_->certHashHex; }

void WebTransportServer::SendStream(ClientID clientId, StreamClass /*cls*/,
                                    const uint8_t* data, size_t len) {
    // TODO(GW1-H3): route per StreamClass onto the WebTransport stream tier with
    // RFC 9218 urgency (control=bidi, state=newest-wins uni, vision/bulk=uni).
    std::lock_guard<std::mutex> lk(impl_->txMutex);
    impl_->pendingTx.push_back({clientId, false, std::vector<uint8_t>(data, data + len)});
}

void WebTransportServer::BroadcastStream(StreamClass /*cls*/, const uint8_t* data, size_t len) {
    std::lock_guard<std::mutex> lk(impl_->txMutex);
    impl_->pendingTx.push_back({0, true, std::vector<uint8_t>(data, data + len)});
}

std::vector<InboundMessage> WebTransportServer::DrainInbound() {
    std::lock_guard<std::mutex> lk(impl_->inboundMutex);
    std::vector<InboundMessage> out;
    out.swap(impl_->inbound);
    return out;
}

std::vector<ClientID> WebTransportServer::DrainDisconnects() {
    std::lock_guard<std::mutex> lk(impl_->disconnectMutex);
    std::vector<ClientID> out;
    out.swap(impl_->disconnects);
    return out;
}

int WebTransportServer::GetClientCount() const {
    return (int)impl_->conns.size();
}

void WebTransportServer::Shutdown() {
    if (!impl_) return;
    if (impl_->running.exchange(false)) {
        if (impl_->thread.joinable()) impl_->thread.join();
        for (auto& [id, c] : impl_->conns) {
            if (c->conn) ngtcp2_conn_del(c->conn);
            if (c->ssl) SSL_free(c->ssl);
            if (c->osslCtx) ngtcp2_crypto_ossl_ctx_del(c->osslCtx);
            delete c;
        }
        impl_->conns.clear();
        if (impl_->fd >= 0) { close(impl_->fd); impl_->fd = -1; }
        if (impl_->sslCtx) { SSL_CTX_free(impl_->sslCtx); impl_->sslCtx = nullptr; }
    }
}
