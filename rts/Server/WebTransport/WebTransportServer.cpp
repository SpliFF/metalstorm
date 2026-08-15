// WebTransportServer — QUIC + HTTP/3 + WebTransport server (PLAN-game-worker.md GW1/GW1-H3).
//
// Layers:
//   1. QUIC transport — UDP socket + ngtcp2 server connection lifecycle
//      (accept → handshake via OpenSSL/ngtcp2_crypto_ossl → stream I/O → close),
//      ephemeral self-signed ECDSA P-256 cert in dev (SHA-256 in CertHash() for
//      the client's serverCertificateHashes pin).
//   2. HTTP/3 — hand-rolled framing (control stream + SETTINGS + HEADERS frames)
//      with nghttp3's *standalone QPACK* encoder/decoder for header (de)compression.
//      We hand-roll the framing rather than use nghttp3_conn because nghttp3's
//      settings struct cannot emit the WebTransport-specific SETTINGS identifiers
//      (ENABLE_WEBTRANSPORT 0x2b603742, WT_MAX_SESSIONS 0xc671706a) that Chrome
//      requires — we need full control over the SETTINGS frame.
//   3. WebTransport (draft-02, the wire version Chrome ships) — extended CONNECT
//      (:protocol=webtransport → :status 200), then WT stream framing demux:
//        • uni stream:  varint 0x54 + session-id varint + raw payload (read-to-FIN)
//        • bidi stream: varint 0x41 + session-id varint + raw payload
//        • datagram:    quarter-stream-id varint + raw payload
//      Note 0x54/0x41 are >63 so each encodes as the 2-byte varint 0x40 0x54 /
//      0x40 0x41 — always decode as a varint, never compare the first raw byte.
//
// Client contract (must match client/src/core/transport.ts WebTransportAdapter):
//   • control  = client-opened WT *bidi* stream carrying length-delimited
//                [u32 LE len][payload] frames in BOTH directions.
//   • state    = one-shot server→client WT *uni* stream (read-to-FIN), newest-wins.
//   • vision   = one-shot server→client WT *uni* stream.
//   • bulk     = one-shot server→client WT *uni* stream.
//   • datagram = quarter-stream-id-prefixed QUIC datagram.

#include "WebTransportServer.h"
#include "Server/NetworkServer.h" // InboundMessage

#include <ngtcp2/ngtcp2.h>
#include <ngtcp2/ngtcp2_crypto.h>
#include <ngtcp2/ngtcp2_crypto_ossl.h>

#include <nghttp3/nghttp3.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <openssl/pem.h>
#include <openssl/rand.h>

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

constexpr int kMaxCidLen = NGTCP2_MAX_CIDLEN;
// Fixed length for the connection IDs we issue. Short-header (1-RTT) packets
// don't encode the DCID length on the wire, so the receiver must know it a
// priori — it MUST equal the length of every CID we hand out (initial SCID +
// every get_new_connection_id). Pass this as `short_dcidlen` to
// ngtcp2_pkt_decode_version_cid or post-handshake packets won't route.
constexpr size_t kScidLen = 18;
constexpr size_t kMaxUdpPayload = 1452; // conservative IPv4 path MTU

// S5: ceiling on a single length-delimited control-bidi message. The 4-byte
// length prefix is attacker-controlled; without a cap the receiver would
// buffer toward an arbitrary u32 (up to 4 GB) before the frame ever completes.
// Real control messages (auth, viewport, commands, console) are kilobytes.
constexpr uint32_t kMaxControlMsg = 4u * 1024 * 1024; // 4 MB

// S5: ceiling on simultaneously-tracked QUIC connections. A new Initial beyond
// this is dropped (ngtcp2 will retransmit / the client retries); bounds the
// per-connection TLS + stream-buffer memory a flood can pin.
constexpr size_t kMaxWtConnections = 512;

// PLAN-security-hardening.md task 5 (G3): cert lifecycle timing.
constexpr int64_t kCertValiditySeconds = 60LL * 60 * 24 * 13;      // 13 days (<14d serverCertificateHashes cap)
constexpr int64_t kCertHalfLifeSeconds = kCertValiditySeconds / 2;  // Hashes-mode rotation cadence
constexpr int64_t kCertCheckIntervalNs = 60LL * 60 * 1'000'000'000LL; // hourly poll (Webpki mtime + Hashes rotation)

// HTTP/3 unidirectional stream types (RFC 9114 / 9204).
constexpr uint64_t kH3StreamControl = 0x00;
constexpr uint64_t kH3StreamQpackEnc = 0x02;
constexpr uint64_t kH3StreamQpackDec = 0x03;
// HTTP/3 frame types.
constexpr uint64_t kH3FrameData = 0x00;
constexpr uint64_t kH3FrameHeaders = 0x01;
constexpr uint64_t kH3FrameSettings = 0x04;
// WebTransport (draft-02) stream signals.
constexpr uint64_t kWtUniStream = 0x54;
constexpr uint64_t kWtBidiStream = 0x41;
// HTTP/3 SETTINGS identifiers.
constexpr uint64_t kSetQpackMaxTableCapacity = 0x01;
constexpr uint64_t kSetQpackBlockedStreams = 0x07;
constexpr uint64_t kSetEnableConnectProtocol = 0x08;
constexpr uint64_t kSetH3Datagram = 0x33;
constexpr uint64_t kSetEnableWebtransport = 0x2b603742; // draft-02 (Chrome)
constexpr uint64_t kSetWebtransportMaxSessions = 0xc671706a; // draft-04+ (belt-and-braces)

// Verbose ngtcp2 transport logging, gated on the SPRING_QUIC_LOG env var so it
// costs nothing in production. When on, ngtcp2's per-frame trace + our
// CONNECTION_CLOSE dumps go to stderr — the fast path to reading exactly why a
// peer (e.g. Chrome) tore the session down.
bool QuicLogEnabled() {
    static const bool on = []() {
        const char* v = std::getenv("SPRING_QUIC_LOG");
        return v && v[0] && v[0] != '0';
    }();
    return on;
}

void QuicLogCb(void* /*user_data*/, const char* fmt, ...) {
    std::fputs("[quic] ", stderr);
    va_list ap;
    va_start(ap, fmt);
    std::vfprintf(stderr, fmt, ap);
    va_end(ap);
    std::fputc('\n', stderr);
}

ngtcp2_tstamp NowNs() {
    using namespace std::chrono;
    return (ngtcp2_tstamp)duration_cast<nanoseconds>(
               steady_clock::now().time_since_epoch())
        .count();
}

// QUIC variable-length integer (RFC 9000 §16). Returns bytes written.
size_t PutVarint(uint8_t* p, uint64_t v) {
    if (v <= 0x3f) { p[0] = (uint8_t)v; return 1; }
    if (v <= 0x3fff) {
        p[0] = 0x40 | (uint8_t)(v >> 8);
        p[1] = (uint8_t)v;
        return 2;
    }
    if (v <= 0x3fffffff) {
        p[0] = 0x80 | (uint8_t)(v >> 24);
        p[1] = (uint8_t)(v >> 16);
        p[2] = (uint8_t)(v >> 8);
        p[3] = (uint8_t)v;
        return 4;
    }
    p[0] = 0xc0 | (uint8_t)(v >> 56);
    p[1] = (uint8_t)(v >> 48);
    p[2] = (uint8_t)(v >> 40);
    p[3] = (uint8_t)(v >> 32);
    p[4] = (uint8_t)(v >> 24);
    p[5] = (uint8_t)(v >> 16);
    p[6] = (uint8_t)(v >> 8);
    p[7] = (uint8_t)v;
    return 8;
}

// Decode a QUIC varint from p[0..len). Returns bytes consumed, or 0 if the
// buffer doesn't yet hold the whole varint (caller should accumulate more).
size_t GetVarint(const uint8_t* p, size_t len, uint64_t& out) {
    if (len < 1) return 0;
    size_t n = (size_t)1 << (p[0] >> 6);
    if (len < n) return 0;
    uint64_t v = p[0] & 0x3f;
    for (size_t i = 1; i < n; i++) v = (v << 8) | p[i];
    out = v;
    return n;
}

void PutLe32(uint8_t* p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}
uint32_t GetLe32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

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
    k.len = n > (size_t)kMaxCidLen ? (size_t)kMaxCidLen : n;
    std::memcpy(k.data, d, k.len);
    return k;
}

} // namespace

// ───────────────────────────── per-stream state ─────────────────────────────

// Outbound state for one QUIC stream we write on (server uni, server H3 control/
// qpack, or the client control bidi we write responses + control frames onto).
struct OutStream {
    std::vector<uint8_t> pending; // unsent, already-framed bytes
    size_t off = 0;               // bytes of `pending` handed to ngtcp2 so far
    bool finQueued = false;       // one-shot stream: FIN after pending drains
    bool finSent = false;
    bool blockedThisRound = false;
    StreamClass cls = StreamClass::Control; // priority tier (drives flush order)
};

// RFC 9218 urgency for a tier — lower drains first. H3 control/qpack + the
// CONNECT response + the control channel are Control (0); per-frame State (1)
// outranks Vision (3) outranks Bulk (5), so a large Bulk transfer can never
// schedule ahead of per-frame entity state on this connection.
static int TierUrgency(StreamClass c) {
    switch (c) {
        case StreamClass::Control:  return 0;
        case StreamClass::State:    return 1;
        case StreamClass::Vision:   return 3;
        case StreamClass::Bulk:     return 5;
        default:                    return 1;
    }
}

// Inbound classification + reassembly for one peer-initiated QUIC stream.
struct RxStream {
    enum Kind { Unknown, Ignore, H3Request, WtUni, WtBidiControl };
    Kind kind = Unknown;
    bool isUni = false;
    std::vector<uint8_t> buf; // pre-classification prefix, then app/H3 bytes
};

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

    // HTTP/3 + WebTransport session state.
    nghttp3_qpack_decoder* qdec = nullptr;
    nghttp3_qpack_encoder* qenc = nullptr;
    int64_t ctrlUniId = -1;     // server H3 control stream
    int64_t qpackEncId = -1;    // server QPACK encoder stream
    int64_t qpackDecId = -1;    // server QPACK decoder stream
    int64_t sessionId = -1;     // CONNECT request stream id (== WT session id)
    int64_t controlBidiId = -1; // client control bidi stream (server writes here too)
    // newest-wins, keyed by lane: the last server State uni stream for each
    // logical stream. A new State send on lane L resets only lastStateUni[L], so
    // independent State streams (entity, piece) don't clobber one another.
    std::unordered_map<uint32_t, int64_t> lastStateUni;
    bool wtEstablished = false;

    // Per-stream inbound + outbound.
    std::unordered_map<int64_t, RxStream> rx;
    std::unordered_map<int64_t, OutStream> out;
    std::vector<int64_t> outOrder; // deterministic flush order
    std::deque<std::vector<uint8_t>> txDatagrams;

    // Control frames queued before the control bidi stream exists.
    std::deque<std::vector<uint8_t>> pendingControl;

    // Uni-stream sends (state/vision/bulk) that couldn't open a stream yet
    // because the peer's uni-stream limit is momentarily exhausted (a burst).
    // Retried as the peer raises the limit via MAX_STREAMS.
    struct PendingUni { StreamClass cls; uint32_t lane; std::vector<uint8_t> data; };
    std::deque<PendingUni> pendingUni;
};

// ───────────────────────────────── Impl ─────────────────────────────────────

struct WebTransportServerImpl {
    int fd = -1;
    int port = 0;
    std::thread thread;
    std::atomic<bool> running{false};
    bool echoMode = false;

    SSL_CTX* sslCtx = nullptr;
    // Guards certHashHex + pendingCertHashHex: written on the Run() thread by
    // cert reload/rotation (LoadActiveCert / CheckCertReload), read from the
    // HTTP thread via CertHash()/CertHashes() for /api/wt/info — an unguarded
    // std::string rewrite there is a torn read.
    mutable std::mutex certHashMutex;
    std::string certHashHex;

    // PLAN-security-hardening.md task 5 (G3): dual-mode cert provisioning.
    WtCertMode certMode = WtCertMode::Hashes;

    // Webpki mode: the on-disk PEM paths + the mtimes we last loaded, so the
    // hourly poll only reloads when the files actually changed.
    std::string certPathOnDisk;
    std::string keyPathOnDisk;
    std::filesystem::file_time_type certMtime{};
    std::filesystem::file_time_type keyMtime{};

    // Hashes mode: the pre-generated "next" cert, kept pending (not loaded
    // into sslCtx) until the half-life rotation promotes it. Published
    // alongside the active hash so a client holding a stale /api/wt/info
    // answer can still connect across the rotation.
    X509* pendingCert = nullptr;
    EVP_PKEY* pendingKey = nullptr;
    std::string pendingCertHashHex;
    ngtcp2_tstamp activeCertLoadedAtNs = 0; // steady-clock timestamp of the last (re)load/rotation

    ngtcp2_tstamp lastCertCheckNs = 0;
    std::atomic<bool> forceReload{false};

    uint32_t nextClientId = 1;

    std::unordered_map<ClientID, WtConn*> conns;
    std::unordered_map<CidKey, ClientID, CidKeyHash> cidToClient;

    std::mutex inboundMutex;
    std::vector<InboundMessage> inbound;
    std::mutex disconnectMutex;
    std::vector<ClientID> disconnects;

    std::mutex txMutex;
    struct PendingTx { ClientID clientId; bool broadcast; StreamClass cls; uint32_t lane; std::vector<uint8_t> data; };
    std::vector<PendingTx> pendingTx;
    // GM kick (PLAN-gm-tools): client IDs to force-close, queued from the sim
    // thread, applied on the network thread in DrainPendingTx. Guarded by txMutex.
    std::vector<ClientID> pendingKicks;

    ~WebTransportServerImpl();

    // TLS / cert lifecycle (PLAN-security-hardening.md task 5, G3).
    bool GenerateCert(X509** outX509, EVP_PKEY** outPkey, std::string& outHashHex);
    bool LoadActiveCert(X509* x509, EVP_PKEY* pkey); // installs into sslCtx, sets certHashHex
    bool GenerateSelfSigned();  // Hashes mode: generate active + pending pair
    bool LoadFromDisk(const std::string& certPath, const std::string& keyPath); // Webpki mode
    bool SetupTls(const std::string& certPath, const std::string& keyPath);
    void CheckCertReload(ngtcp2_tstamp now); // called once per Run() iteration

    void Run();
    WtConn* AcceptConn(const ngtcp2_pkt_hd& hd, const sockaddr* sa, socklen_t salen,
                       const ngtcp2_path& path);
    void CloseConn(WtConn* c);

    // HTTP/3 + WebTransport.
    void OnHandshakeDone(WtConn* c);
    void OnStreamData(WtConn* c, int64_t sid, uint32_t flags, const uint8_t* data, size_t len);
    void OnDatagram(WtConn* c, const uint8_t* data, size_t len);
    bool ClassifyStream(WtConn* c, int64_t sid, RxStream& rx);
    void ProcessH3Request(WtConn* c, int64_t sid, RxStream& rx);
    void DecodeConnect(WtConn* c, int64_t sid, const uint8_t* payload, size_t len);
    void SendConnectResponse(WtConn* c, int64_t sid);
    void ProcessControlBidi(WtConn* c, RxStream& rx);
    void OnAppMessage(WtConn* c, StreamClass cls, const uint8_t* d, size_t n);

    // Outbound helpers (network thread only).
    OutStream& EnsureOut(WtConn* c, int64_t sid);
    void AppendOut(WtConn* c, int64_t sid, const uint8_t* d, size_t n);
    void SendControl(WtConn* c, const uint8_t* d, size_t n);
    bool TryOpenUni(WtConn* c, StreamClass cls, uint32_t lane, const uint8_t* d, size_t n);
    void SendWtUni(WtConn* c, StreamClass cls, uint32_t lane, const uint8_t* d, size_t n);
    void DrainPendingUni(WtConn* c);
    void SendDatagram(WtConn* c, const uint8_t* d, size_t n);
    void DrainPendingTx();
    void FlushConn(WtConn* c);
};

// Set for the duration of a Run() iteration so the static ngtcp2 callbacks can
// reach the owning Impl. The network thread is the only caller.
static thread_local WebTransportServerImpl* tlsImpl = nullptr;

// ──────────────────────────── ngtcp2 callbacks ──────────────────────────────

static ngtcp2_conn* GetConn(ngtcp2_crypto_conn_ref* ref) {
    return static_cast<WtConn*>(ref->user_data)->conn;
}

static void RandCb(uint8_t* dest, size_t destlen, const ngtcp2_rand_ctx*) {
    RAND_bytes(dest, (int)destlen);
}

static int GetNewCidCb(ngtcp2_conn* /*conn*/, ngtcp2_cid* cid, uint8_t* token,
                       size_t cidlen, void* user_data) {
    if (RAND_bytes(cid->data, (int)cidlen) != 1) return NGTCP2_ERR_CALLBACK_FAILURE;
    cid->datalen = cidlen;
    if (RAND_bytes(token, NGTCP2_STATELESS_RESET_TOKENLEN) != 1)
        return NGTCP2_ERR_CALLBACK_FAILURE;
    // Register the new CID so packets the client later routes to it find us.
    if (tlsImpl && user_data) {
        tlsImpl->cidToClient[MakeCidKey(cid->data, cidlen)] =
            static_cast<WtConn*>(user_data)->clientId;
    }
    return 0;
}

static int HandshakeCompletedCb(ngtcp2_conn* /*conn*/, void* user_data) {
    if (tlsImpl) tlsImpl->OnHandshakeDone(static_cast<WtConn*>(user_data));
    return 0;
}

static int RecvStreamDataCb(ngtcp2_conn* /*conn*/, uint32_t flags, int64_t stream_id,
                            uint64_t /*offset*/, const uint8_t* data, size_t datalen,
                            void* user_data, void* /*stream_user_data*/) {
    if (tlsImpl)
        tlsImpl->OnStreamData(static_cast<WtConn*>(user_data), stream_id, flags, data, datalen);
    return 0;
}

static int StreamCloseCb(ngtcp2_conn* /*conn*/, uint32_t /*flags*/, int64_t stream_id,
                         uint64_t /*app_error_code*/, void* user_data,
                         void* /*stream_user_data*/) {
    static_cast<WtConn*>(user_data)->rx.erase(stream_id);
    return 0;
}

static int RecvDatagramCb(ngtcp2_conn* /*conn*/, uint32_t /*flags*/, const uint8_t* data,
                          size_t datalen, void* user_data) {
    if (tlsImpl) tlsImpl->OnDatagram(static_cast<WtConn*>(user_data), data, datalen);
    return 0;
}

// ────────────────────────────── TLS / certs ─────────────────────────────────

WebTransportServerImpl::~WebTransportServerImpl() {
    if (pendingCert) X509_free(pendingCert);
    if (pendingKey) EVP_PKEY_free(pendingKey);
}

// Generates one ECDSA P-256 self-signed cert, valid [now, now+13d] (<14d, the
// serverCertificateHashes cap). Used for both the active and the pending cert
// in Hashes mode — the pending one just isn't installed into sslCtx yet.
bool WebTransportServerImpl::GenerateCert(X509** outX509, EVP_PKEY** outPkey,
                                          std::string& outHashHex) {
    EVP_PKEY* pkey = EVP_EC_gen("P-256");
    if (!pkey) return false;
    X509* x509 = X509_new();
    if (!x509) { EVP_PKEY_free(pkey); return false; }
    X509_set_version(x509, 2); // X.509 v3 (Chrome serverCertificateHashes requires v3)
    ASN1_INTEGER_set(X509_get_serialNumber(x509), 1);
    X509_gmtime_adj(X509_getm_notBefore(x509), 0);
    X509_gmtime_adj(X509_getm_notAfter(x509), (long)kCertValiditySeconds);
    X509_set_pubkey(x509, pkey);
    X509_NAME* name = X509_get_subject_name(x509);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
                               (const unsigned char*)"spring-server", -1, -1, 0);
    X509_set_issuer_name(x509, name);
    // SubjectAltName — Chrome's TLS stack wants a SAN.
    {
        X509_EXTENSION* ext = X509V3_EXT_conf_nid(
            nullptr, nullptr, NID_subject_alt_name,
            const_cast<char*>("DNS:localhost,IP:127.0.0.1"));
        if (ext) { X509_add_ext(x509, ext, -1); X509_EXTENSION_free(ext); }
    }
    if (!X509_sign(x509, pkey, EVP_sha256())) {
        X509_free(x509); EVP_PKEY_free(pkey); return false;
    }
    unsigned char* der = nullptr;
    int derLen = i2d_X509(x509, &der);
    if (derLen > 0 && der) {
        unsigned char md[EVP_MAX_MD_SIZE];
        unsigned int mdLen = 0;
        EVP_Digest(der, derLen, md, &mdLen, EVP_sha256(), nullptr);
        outHashHex = ToHex(md, mdLen);
        OPENSSL_free(der);
    }
    *outX509 = x509;
    *outPkey = pkey;
    return true;
}

// Installs `x509`/`pkey` as the live cert (SSL_CTX_use_* up-refs its own
// copy — the caller still owns and must free its reference) and refreshes
// certHashHex + the rotation clock. TLS 1.3 doesn't renegotiate the server
// cert mid-session, so this is safe to call on a live sslCtx: already
// handshaked connections keep whatever cert they got; only new SSL_new(sslCtx)
// accepts see the change.
bool WebTransportServerImpl::LoadActiveCert(X509* x509, EVP_PKEY* pkey) {
    if (!x509 || !pkey) return false;
    if (SSL_CTX_use_certificate(sslCtx, x509) != 1) return false;
    if (SSL_CTX_use_PrivateKey(sslCtx, pkey) != 1) return false;
    unsigned char* der = nullptr;
    int derLen = i2d_X509(x509, &der);
    if (derLen > 0 && der) {
        unsigned char md[EVP_MAX_MD_SIZE];
        unsigned int mdLen = 0;
        EVP_Digest(der, derLen, md, &mdLen, EVP_sha256(), nullptr);
        std::string hashHex = ToHex(md, mdLen);
        OPENSSL_free(der);
        std::lock_guard<std::mutex> lk(certHashMutex);
        certHashHex = std::move(hashHex);
    }
    activeCertLoadedAtNs = NowNs();
    return true;
}

// Hashes mode (no --wt-cert/--wt-key): generate the active cert and load it,
// then pre-generate the "next" cert and keep it pending (not installed) so
// its hash can be published now — see CertHashes().
bool WebTransportServerImpl::GenerateSelfSigned() {
    certMode = WtCertMode::Hashes;
    X509* activeX509 = nullptr; EVP_PKEY* activeKey = nullptr; std::string activeHash;
    if (!GenerateCert(&activeX509, &activeKey, activeHash)) return false;
    bool ok = LoadActiveCert(activeX509, activeKey);
    X509_free(activeX509);
    EVP_PKEY_free(activeKey);
    if (!ok) return false;

    if (pendingCert) { X509_free(pendingCert); pendingCert = nullptr; }
    if (pendingKey) { EVP_PKEY_free(pendingKey); pendingKey = nullptr; }
    std::string pendingHash;
    const bool pendingOk = GenerateCert(&pendingCert, &pendingKey, pendingHash);
    std::lock_guard<std::mutex> lk(certHashMutex);
    pendingCertHashHex = std::move(pendingHash);
    return pendingOk;
}

// Webpki mode (--wt-cert/--wt-key given): read PEM files from disk, install
// them, and remember their mtimes so CheckCertReload() only reloads on an
// actual change (e.g. a certbot renewal).
bool WebTransportServerImpl::LoadFromDisk(const std::string& certPath, const std::string& keyPath) {
    std::ifstream cf(certPath, std::ios::binary);
    std::ifstream kf(keyPath, std::ios::binary);
    if (!cf.is_open() || !kf.is_open()) return false;
    std::ostringstream cbuf, kbuf;
    cbuf << cf.rdbuf();
    kbuf << kf.rdbuf();
    const std::string certPem = cbuf.str();
    const std::string keyPem = kbuf.str();

    BIO* cbio = BIO_new_mem_buf(certPem.data(), (int)certPem.size());
    X509* cert = PEM_read_bio_X509(cbio, nullptr, nullptr, nullptr);
    BIO_free(cbio);
    BIO* kbio = BIO_new_mem_buf(keyPem.data(), (int)keyPem.size());
    EVP_PKEY* key = PEM_read_bio_PrivateKey(kbio, nullptr, nullptr, nullptr);
    BIO_free(kbio);

    bool ok = cert && key && LoadActiveCert(cert, key);
    if (cert) X509_free(cert);
    if (key) EVP_PKEY_free(key);
    if (!ok) return false;

    certPathOnDisk = certPath;
    keyPathOnDisk = keyPath;
    std::error_code ec;
    certMtime = std::filesystem::last_write_time(certPath, ec);
    keyMtime = std::filesystem::last_write_time(keyPath, ec);
    return true;
}

static int AlpnSelectCb(SSL*, const unsigned char** out, unsigned char* outlen,
                        const unsigned char* in, unsigned int inlen, void*) {
    static const unsigned char h3[] = {2, 'h', '3'};
    if (SSL_select_next_proto((unsigned char**)out, outlen, h3, sizeof(h3), in, inlen) !=
        OPENSSL_NPN_NEGOTIATED) {
        return SSL_TLSEXT_ERR_ALERT_FATAL;
    }
    return SSL_TLSEXT_ERR_OK;
}

bool WebTransportServerImpl::SetupTls(const std::string& certPath, const std::string& keyPath) {
    if (ngtcp2_crypto_ossl_init() != 0) return false;
    sslCtx = SSL_CTX_new(TLS_server_method());
    if (!sslCtx) return false;
    SSL_CTX_set_min_proto_version(sslCtx, TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(sslCtx, TLS1_3_VERSION);
    SSL_CTX_set_alpn_select_cb(sslCtx, AlpnSelectCb, nullptr);
    if (!certPath.empty() && !keyPath.empty()) {
        if (!LoadFromDisk(certPath, keyPath)) {
            std::fprintf(stderr, "[webtransport] failed to load --wt-cert '%s' / --wt-key '%s'\n",
                         certPath.c_str(), keyPath.c_str());
            return false;
        }
        certMode = WtCertMode::Webpki;
        return true;
    }
    return GenerateSelfSigned();
}

// Called once per Run() loop iteration (~every <=50ms). Cheap unless the
// hourly interval elapsed or a caller forced it via WebTransportServer::
// ReloadCert() — see WebTransportServer.h. ReloadCert() is deliberately NOT
// wired to an OS signal (see the note above ReloadCert() in the header):
// signal delivery while a webpki-mode cert is loaded was found to corrupt
// OpenSSL's heap state (crash at process-exit cleanup), reproducibly,
// independent of whether this function's body ever actually ran. The hourly
// poll below is signal-free and was verified safe under the same conditions.
void WebTransportServerImpl::CheckCertReload(ngtcp2_tstamp now) {
    const bool forced = forceReload.exchange(false);
    if (!forced && (now - lastCertCheckNs) < (ngtcp2_tstamp)kCertCheckIntervalNs) return;
    lastCertCheckNs = now;

    if (certMode == WtCertMode::Webpki) {
        std::error_code ec;
        auto cm = std::filesystem::last_write_time(certPathOnDisk, ec);
        const bool certChanged = !ec && cm != certMtime;
        auto km = std::filesystem::last_write_time(keyPathOnDisk, ec);
        const bool keyChanged = !ec && km != keyMtime;
        if (forced || certChanged || keyChanged) {
            if (LoadFromDisk(certPathOnDisk, keyPathOnDisk)) {
                std::fprintf(stderr, "[webtransport] reloaded cert from disk (certhash=%s)\n",
                             certHashHex.c_str());
            } else {
                std::fprintf(stderr,
                    "[webtransport] cert reload FAILED (%s / %s) — keeping the prior cert active\n",
                    certPathOnDisk.c_str(), keyPathOnDisk.c_str());
            }
        }
        return;
    }

    // Hashes mode: rotate at half-life (or immediately if forced) by
    // promoting the pre-generated pending cert, then generate its replacement
    // so a pending cert is always ready.
    const bool halfLifeElapsed =
        (now - activeCertLoadedAtNs) >= (ngtcp2_tstamp)(kCertHalfLifeSeconds * 1'000'000'000LL);
    if (forced || halfLifeElapsed) {
        if (pendingCert && pendingKey) {
            X509* newActive = pendingCert;
            EVP_PKEY* newActiveKey = pendingKey;
            pendingCert = nullptr;
            pendingKey = nullptr;
            const bool ok = LoadActiveCert(newActive, newActiveKey);
            X509_free(newActive);
            EVP_PKEY_free(newActiveKey);
            if (ok) {
                std::fprintf(stderr, "[webtransport] rotated self-signed cert (certhash=%s)\n",
                             certHashHex.c_str());
            }
        }
        if (!pendingCert) {
            std::string pendingHash;
            if (GenerateCert(&pendingCert, &pendingKey, pendingHash)) {
                std::lock_guard<std::mutex> lk(certHashMutex);
                pendingCertHashHex = std::move(pendingHash);
            }
        }
    }
}

// ─────────────────────────── connection accept ──────────────────────────────

WtConn* WebTransportServerImpl::AcceptConn(const ngtcp2_pkt_hd& hd, const sockaddr* sa,
                                           socklen_t salen, const ngtcp2_path& path) {
    // S5: refuse new connections past the cap (caller drops the packet).
    if (conns.size() >= kMaxWtConnections)
        return nullptr;

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

    nghttp3_qpack_decoder_new(&c->qdec, 0, 0, nghttp3_mem_default());
    nghttp3_qpack_encoder_new(&c->qenc, 0, nghttp3_mem_default());

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

    ngtcp2_cid scid{};
    scid.datalen = kScidLen;
    RAND_bytes(scid.data, (int)scid.datalen);

    ngtcp2_settings settings;
    ngtcp2_settings_default(&settings);
    settings.initial_ts = NowNs();
    if (QuicLogEnabled()) settings.log_printf = QuicLogCb;

    ngtcp2_transport_params params;
    ngtcp2_transport_params_default(&params);
    params.initial_max_streams_bidi = 128;
    params.initial_max_streams_uni = 128;
    params.initial_max_stream_data_bidi_local = 512 * 1024;
    params.initial_max_stream_data_bidi_remote = 512 * 1024;
    params.initial_max_stream_data_uni = 512 * 1024;
    params.initial_max_data = 8 * 1024 * 1024;
    params.max_datagram_frame_size = 1500; // enable QUIC datagrams (WT datagrams)
    // Advertise an idle timeout so a half-dead peer is reaped, and (paired with
    // the keep-alive set below) so an *idle* session — e.g. a connected client
    // not yet receiving entity state — is held open by PINGs rather than silently
    // ageing out. Without this the effective timeout is solely the peer's, and a
    // gap in traffic could drop the link (the "unstable even before streaming"
    // symptom). 30 s is comfortably longer than the keep-alive interval.
    params.max_idle_timeout = 30 * NGTCP2_SECONDS;
    params.original_dcid = hd.dcid;
    params.original_dcid_present = 1;

    int rv = ngtcp2_conn_server_new(&c->conn, &hd.scid, &scid, &path,
                                    NGTCP2_PROTO_VER_V1, &cb, &settings, &params,
                                    nullptr, c);
    if (rv != 0) {
        nghttp3_qpack_decoder_del(c->qdec);
        nghttp3_qpack_encoder_del(c->qenc);
        SSL_free(c->ssl); ngtcp2_crypto_ossl_ctx_del(c->osslCtx); delete c; return nullptr;
    }
    ngtcp2_conn_set_tls_native_handle(c->conn, c->osslCtx);
    // Keep an otherwise-idle connection alive with QUIC PINGs. The browser holds
    // the session open even during lulls in the entity stream; without this the
    // connection can idle out (see max_idle_timeout above). Interval < idle.
    ngtcp2_conn_set_keep_alive_timeout(c->conn, 10 * NGTCP2_SECONDS);

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
    if (c->qdec) nghttp3_qpack_decoder_del(c->qdec);
    if (c->qenc) nghttp3_qpack_encoder_del(c->qenc);
    if (c->conn) ngtcp2_conn_del(c->conn);
    if (c->ssl) SSL_free(c->ssl);
    if (c->osslCtx) ngtcp2_crypto_ossl_ctx_del(c->osslCtx);
    delete c;
}

// ─────────────────────── HTTP/3 + WebTransport layer ────────────────────────

void WebTransportServerImpl::OnHandshakeDone(WtConn* c) {
    c->handshakeDone = true;

    // Server H3 control stream: type 0x00 + SETTINGS frame.
    if (ngtcp2_conn_open_uni_stream(c->conn, &c->ctrlUniId, nullptr) == 0) {
        std::vector<uint8_t> settings;
        auto putSetting = [&](uint64_t id, uint64_t val) {
            uint8_t b[16];
            size_t k = PutVarint(b, id);
            k += PutVarint(b + k, val);
            settings.insert(settings.end(), b, b + k);
        };
        putSetting(kSetQpackMaxTableCapacity, 0);
        putSetting(kSetQpackBlockedStreams, 0);
        putSetting(kSetEnableConnectProtocol, 1);
        putSetting(kSetH3Datagram, 1);
        putSetting(kSetEnableWebtransport, 1);
        putSetting(kSetWebtransportMaxSessions, 16);

        std::vector<uint8_t> ctl;
        uint8_t hdr[24];
        size_t k = PutVarint(hdr, kH3StreamControl); // uni stream type
        k += PutVarint(hdr + k, kH3FrameSettings);   // SETTINGS frame type
        k += PutVarint(hdr + k, settings.size());    // frame length
        ctl.insert(ctl.end(), hdr, hdr + k);
        ctl.insert(ctl.end(), settings.begin(), settings.end());
        OutStream& o = EnsureOut(c, c->ctrlUniId);
        o.pending = std::move(ctl);
    }

    // Server QPACK encoder + decoder streams (type byte only; no dynamic table).
    if (ngtcp2_conn_open_uni_stream(c->conn, &c->qpackEncId, nullptr) == 0) {
        uint8_t t[8];
        size_t k = PutVarint(t, kH3StreamQpackEnc);
        AppendOut(c, c->qpackEncId, t, k);
    }
    if (ngtcp2_conn_open_uni_stream(c->conn, &c->qpackDecId, nullptr) == 0) {
        uint8_t t[8];
        size_t k = PutVarint(t, kH3StreamQpackDec);
        AppendOut(c, c->qpackDecId, t, k);
    }
}

void WebTransportServerImpl::OnStreamData(WtConn* c, int64_t sid, uint32_t flags,
                                          const uint8_t* data, size_t len) {
    // Return the flow-control credit these bytes used, per stream and for the
    // connection. Every byte handed to this callback is copied into `rx.buf`
    // below, so it is consumed the moment we are called and the window can be
    // reopened immediately.
    //
    // Without this the transport parameters (initial_max_stream_data_bidi_remote
    // = 512 KiB, initial_max_data = 8 MiB) are not a rate limit but a LIFETIME
    // budget: a client's control bidi stream carries every command, viewport
    // and console message it will ever send, and at 512 KiB cumulative the
    // stream stalls forever with no error anywhere — the writes just stop
    // arriving. Found via PLAN-test-automation P7, where a single ~600 KB
    // screenshot reply crossed the line in one message and wedged the client
    // permanently; a long enough ordinary game would have got there on its own.
    if (len > 0 && c->conn != nullptr) {
        ngtcp2_conn_extend_max_stream_offset(c->conn, sid, len);
        ngtcp2_conn_extend_max_offset(c->conn, len);
    }

    bool fin = (flags & NGTCP2_STREAM_DATA_FLAG_FIN) != 0;
    RxStream& rx = c->rx[sid];

    if (rx.kind == RxStream::Unknown) {
        rx.isUni = (sid & 0x2) != 0;
        rx.buf.insert(rx.buf.end(), data, data + len);
        if (!ClassifyStream(c, sid, rx)) {
            // Need more bytes to classify; wait (unless FIN with nothing usable).
            if (fin) c->rx.erase(sid);
            return;
        }
    } else {
        rx.buf.insert(rx.buf.end(), data, data + len);
    }

    switch (rx.kind) {
        case RxStream::Ignore:
            rx.buf.clear();
            break;
        case RxStream::H3Request:
            ProcessH3Request(c, sid, rx);
            break;
        case RxStream::WtBidiControl:
            ProcessControlBidi(c, rx);
            break;
        case RxStream::WtUni:
            if (fin) {
                OnAppMessage(c, StreamClass::State, rx.buf.data(), rx.buf.size());
                c->rx.erase(sid);
                return;
            }
            break;
        default:
            break;
    }
    if (fin && rx.kind != RxStream::WtBidiControl) c->rx.erase(sid);
}

// Decode the leading varint(s) of a freshly opened stream and decide its role.
// Returns false if more bytes are needed before a decision can be made.
bool WebTransportServerImpl::ClassifyStream(WtConn* c, int64_t sid, RxStream& rx) {
    const uint8_t* p = rx.buf.data();
    size_t n = rx.buf.size();
    uint64_t type = 0;
    size_t t = GetVarint(p, n, type);
    if (t == 0) return false; // incomplete varint

    if (rx.isUni) {
        if (type == kWtUniStream) {
            uint64_t sess = 0;
            size_t s = GetVarint(p + t, n - t, sess);
            if (s == 0) return false; // need session-id varint
            rx.kind = RxStream::WtUni;
            rx.buf.erase(rx.buf.begin(), rx.buf.begin() + t + s);
            return true;
        }
        // H3 control / qpack / push / unknown uni — we don't need their content.
        rx.kind = RxStream::Ignore;
        rx.buf.clear();
        return true;
    }

    // Bidirectional stream.
    if (type == kWtBidiStream) {
        uint64_t sess = 0;
        size_t s = GetVarint(p + t, n - t, sess);
        if (s == 0) return false;
        rx.kind = RxStream::WtBidiControl;
        rx.buf.erase(rx.buf.begin(), rx.buf.begin() + t + s);
        c->controlBidiId = sid;
        EnsureOut(c, sid); // server writes control frames + 200-less data here
        // Flush any control frames queued before the channel existed.
        while (!c->pendingControl.empty()) {
            auto& m = c->pendingControl.front();
            SendControl(c, m.data(), m.size());
            c->pendingControl.pop_front();
        }
        return true;
    }
    // Otherwise an H3 request stream (HEADERS frame, type 0x01) — the CONNECT.
    rx.kind = RxStream::H3Request;
    return true; // keep bytes; ProcessH3Request parses frames
}

void WebTransportServerImpl::ProcessH3Request(WtConn* c, int64_t sid, RxStream& rx) {
    for (;;) {
        const uint8_t* p = rx.buf.data();
        size_t n = rx.buf.size();
        uint64_t ftype = 0, flen = 0;
        size_t a = GetVarint(p, n, ftype);
        if (a == 0) break;
        size_t b = GetVarint(p + a, n - a, flen);
        if (b == 0) break;
        if (n < a + b + flen) break; // incomplete frame body
        const uint8_t* payload = p + a + b;
        if (ftype == kH3FrameHeaders) {
            DecodeConnect(c, sid, payload, (size_t)flen);
        }
        // ftype == kH3FrameData (capsules) and others ignored.
        rx.buf.erase(rx.buf.begin(), rx.buf.begin() + a + b + (size_t)flen);
    }
}

void WebTransportServerImpl::DecodeConnect(WtConn* c, int64_t sid,
                                           const uint8_t* payload, size_t len) {
    nghttp3_qpack_stream_context* sctx = nullptr;
    if (nghttp3_qpack_stream_context_new(&sctx, sid, nghttp3_mem_default()) != 0) return;

    std::string method, protocol;
    const uint8_t* p = payload;
    size_t left = len;
    for (;;) {
        nghttp3_qpack_nv nv;
        uint8_t fl = 0;
        nghttp3_ssize r = nghttp3_qpack_decoder_read_request(c->qdec, sctx, &nv, &fl,
                                                             p, left, /*fin=*/1);
        if (r < 0) break;
        p += r;
        left -= (size_t)r;
        if (fl & NGHTTP3_QPACK_DECODE_FLAG_EMIT) {
            nghttp3_vec nm = nghttp3_rcbuf_get_buf(nv.name);
            nghttp3_vec vl = nghttp3_rcbuf_get_buf(nv.value);
            std::string name((const char*)nm.base, nm.len);
            std::string val((const char*)vl.base, vl.len);
            if (name == ":method") method = val;
            else if (name == ":protocol") protocol = val;
            nghttp3_rcbuf_decref(nv.name);
            nghttp3_rcbuf_decref(nv.value);
        }
        if (fl & NGHTTP3_QPACK_DECODE_FLAG_FINAL) break;
        if (r == 0) break;
    }
    nghttp3_qpack_stream_context_del(sctx);

    if (method == "CONNECT" && protocol == "webtransport") {
        c->sessionId = sid;
        c->wtEstablished = true;
        SendConnectResponse(c, sid);
        std::fprintf(stderr, "[webtransport] session established (client=%u stream=%lld)\n",
                     c->clientId, (long long)sid);
    }
}

void WebTransportServerImpl::SendConnectResponse(WtConn* c, int64_t sid) {
    nghttp3_nv nv{};
    nv.name = (uint8_t*)":status";
    nv.namelen = 7;
    nv.value = (uint8_t*)"200";
    nv.valuelen = 3;
    nv.flags = NGHTTP3_NV_FLAG_NONE;

    nghttp3_buf pbuf, rbuf, ebuf;
    nghttp3_buf_init(&pbuf);
    nghttp3_buf_init(&rbuf);
    nghttp3_buf_init(&ebuf);
    if (nghttp3_qpack_encoder_encode(c->qenc, &pbuf, &rbuf, &ebuf, sid, &nv, 1) == 0) {
        size_t fieldLen = nghttp3_buf_len(&pbuf) + nghttp3_buf_len(&rbuf);
        std::vector<uint8_t> frame;
        uint8_t hdr[16];
        size_t k = PutVarint(hdr, kH3FrameHeaders);
        k += PutVarint(hdr + k, fieldLen);
        frame.insert(frame.end(), hdr, hdr + k);
        frame.insert(frame.end(), pbuf.pos, pbuf.last);
        frame.insert(frame.end(), rbuf.pos, rbuf.last);
        AppendOut(c, sid, frame.data(), frame.size());
        // Any QPACK encoder-stream output rides our encoder stream (empty here).
        if (nghttp3_buf_len(&ebuf) > 0 && c->qpackEncId >= 0)
            AppendOut(c, c->qpackEncId, ebuf.pos, nghttp3_buf_len(&ebuf));
    }
    nghttp3_buf_free(&pbuf, nghttp3_mem_default());
    nghttp3_buf_free(&rbuf, nghttp3_mem_default());
    nghttp3_buf_free(&ebuf, nghttp3_mem_default());
}

void WebTransportServerImpl::ProcessControlBidi(WtConn* c, RxStream& rx) {
    for (;;) {
        if (rx.buf.size() < 4) break;
        uint32_t len = GetLe32(rx.buf.data());
        // S5: reject an oversize declared frame before waiting to buffer it.
        // A garbage/hostile length closes the connection rather than parking
        // an ever-growing receive buffer.
        if (len > kMaxControlMsg) {
            CloseConn(c);
            rx.buf.clear();
            return;
        }
        if (rx.buf.size() < 4 + (size_t)len) break;
        OnAppMessage(c, StreamClass::Control, rx.buf.data() + 4, len);
        rx.buf.erase(rx.buf.begin(), rx.buf.begin() + 4 + (size_t)len);
    }
}

void WebTransportServerImpl::OnDatagram(WtConn* c, const uint8_t* data, size_t len) {
    uint64_t qsid = 0;
    size_t q = GetVarint(data, len, qsid);
    if (q == 0) return;
    OnAppMessage(c, StreamClass::Datagram, data + q, len - q);
}

void WebTransportServerImpl::OnAppMessage(WtConn* c, StreamClass cls,
                                          const uint8_t* d, size_t n) {
    if (echoMode) {
        // De-risk harness: echo back to the sender on the same class.
        switch (cls) {
            case StreamClass::Control: SendControl(c, d, n); break;
            case StreamClass::Datagram: SendDatagram(c, d, n); break;
            default: SendWtUni(c, cls, 0, d, n); break;
        }
        return;
    }
    std::lock_guard<std::mutex> lk(inboundMutex);
    inbound.push_back(InboundMessage{c->clientId, std::vector<uint8_t>(d, d + n)});
}

// ───────────────────────── outbound (seam → streams) ────────────────────────

OutStream& WebTransportServerImpl::EnsureOut(WtConn* c, int64_t sid) {
    auto it = c->out.find(sid);
    if (it != c->out.end()) return it->second;
    c->outOrder.push_back(sid);
    return c->out[sid];
}

void WebTransportServerImpl::AppendOut(WtConn* c, int64_t sid, const uint8_t* d, size_t n) {
    OutStream& o = EnsureOut(c, sid);
    o.pending.insert(o.pending.end(), d, d + n);
}

void WebTransportServerImpl::SendControl(WtConn* c, const uint8_t* d, size_t n) {
    if (c->controlBidiId < 0) {
        c->pendingControl.emplace_back(d, d + n);
        return;
    }
    uint8_t lp[4];
    PutLe32(lp, (uint32_t)n);
    AppendOut(c, c->controlBidiId, lp, 4);
    AppendOut(c, c->controlBidiId, d, n);
}

// Open a fresh server uni stream, frame the payload (0x54 + sessionId), and
// queue it for sending. Returns false if the peer's uni-stream limit is
// momentarily exhausted (caller should buffer + retry).
bool WebTransportServerImpl::TryOpenUni(WtConn* c, StreamClass cls, uint32_t lane,
                                        const uint8_t* d, size_t n) {
    int64_t sid = -1;
    if (ngtcp2_conn_open_uni_stream(c->conn, &sid, nullptr) != 0) return false;
    uint8_t hdr[16];
    size_t k = PutVarint(hdr, kWtUniStream);
    k += PutVarint(hdr + k, (uint64_t)c->sessionId);
    OutStream& o = EnsureOut(c, sid);
    o.cls = cls;
    o.pending.reserve(k + n);
    o.pending.insert(o.pending.end(), hdr, hdr + k);
    o.pending.insert(o.pending.end(), d, d + n);
    o.finQueued = true; // one-shot: FIN after payload

    if (cls == StreamClass::State) {
        // Newest-wins, per lane: reset the prior in-flight State stream *on this
        // lane only* (stale positions). Keying on the lane is what lets several
        // distinct State streams (entity, piece, …) coexist — a shared key would
        // make each new send reset whichever State stream went out last, so the
        // entity snapshot would be RESET by the piece snapshot sent right after
        // it in the same tick and never reach the client.
        int64_t& last = c->lastStateUni[lane];
        if (last >= 0 && last != sid) {
            auto it = c->out.find(last);
            if (it != c->out.end() && !it->second.finSent) {
                ngtcp2_conn_shutdown_stream_write(c->conn, 0, last, 0);
                // Stop tracking the reset stream for flush: its app bytes are
                // abandoned and ngtcp2 emits the RESET_STREAM frame itself. Left
                // in c->out it would never reach finSent (we FIN-less reset it),
                // so it would leak and force a STREAM_SHUT_WR retry every flush.
                c->out.erase(it);
                for (auto oit = c->outOrder.begin(); oit != c->outOrder.end(); ++oit)
                    if (*oit == last) { c->outOrder.erase(oit); break; }
            }
        }
        last = sid;
    }
    return true;
}

void WebTransportServerImpl::SendWtUni(WtConn* c, StreamClass cls, uint32_t lane,
                                      const uint8_t* d, size_t n) {
    if (c->sessionId < 0) return;
    // Preserve order: if a backlog exists, queue behind it rather than jumping.
    if (!c->pendingUni.empty() || !TryOpenUni(c, cls, lane, d, n)) {
        // Cap the backlog so a stalled client can't grow it without bound; drop
        // the oldest State frame first (newest-wins makes stale positions cheap).
        if (c->pendingUni.size() >= 512) {
            for (auto it = c->pendingUni.begin(); it != c->pendingUni.end(); ++it) {
                if (it->cls == StreamClass::State) { c->pendingUni.erase(it); break; }
            }
            if (c->pendingUni.size() >= 512) c->pendingUni.pop_front();
        }
        c->pendingUni.push_back({cls, lane, std::vector<uint8_t>(d, d + n)});
    }
}

void WebTransportServerImpl::DrainPendingUni(WtConn* c) {
    while (!c->pendingUni.empty()) {
        auto& f = c->pendingUni.front();
        if (!TryOpenUni(c, f.cls, f.lane, f.data.data(), f.data.size())) break;
        c->pendingUni.pop_front();
    }
}

void WebTransportServerImpl::SendDatagram(WtConn* c, const uint8_t* d, size_t n) {
    if (c->sessionId < 0) return;
    std::vector<uint8_t> dg;
    uint8_t q[8];
    size_t k = PutVarint(q, (uint64_t)(c->sessionId / 4));
    dg.reserve(k + n);
    dg.insert(dg.end(), q, q + k);
    dg.insert(dg.end(), d, d + n);
    c->txDatagrams.push_back(std::move(dg));
}

void WebTransportServerImpl::DrainPendingTx() {
    std::vector<PendingTx> batch;
    {
        std::lock_guard<std::mutex> lk(txMutex);
        batch.swap(pendingTx);
    }
    for (auto& tx : batch) {
        auto dispatch = [&](WtConn* c) {
            switch (tx.cls) {
                case StreamClass::Control:  SendControl(c, tx.data.data(), tx.data.size()); break;
                case StreamClass::Datagram: SendDatagram(c, tx.data.data(), tx.data.size()); break;
                default:                    SendWtUni(c, tx.cls, tx.lane, tx.data.data(), tx.data.size()); break;
            }
        };
        if (tx.broadcast) {
            for (auto& [id, c] : conns) dispatch(c);
        } else {
            auto it = conns.find(tx.clientId);
            if (it != conns.end()) dispatch(it->second);
        }
    }

    // GM kicks: force-close the named connections. CloseConn queues the id into
    // `disconnects`, so the sim loop's DrainDisconnects() teardown (PlayerLeft
    // broadcast, session removal, PlayerRemoved callin) runs exactly as for any
    // organic disconnect — no special-casing downstream.
    std::vector<ClientID> kicks;
    {
        std::lock_guard<std::mutex> lk(txMutex);
        kicks.swap(pendingKicks);
    }
    for (ClientID id : kicks) {
        auto it = conns.find(id);
        if (it != conns.end())
            CloseConn(it->second);
    }
}

void WebTransportServerImpl::FlushConn(WtConn* c) {
    if (c->closed) return;
    uint8_t out[kMaxUdpPayload];
    ngtcp2_path_storage ps;
    ngtcp2_path_storage_zero(&ps);
    ngtcp2_pkt_info pi{};
    ngtcp2_tstamp ts = NowNs();

    // First, flush any pending WebTransport datagrams.
    while (!c->txDatagrams.empty()) {
        auto& dg = c->txDatagrams.front();
        ngtcp2_vec v{dg.data(), dg.size()};
        int accepted = 0;
        ngtcp2_ssize n = ngtcp2_conn_writev_datagram(
            c->conn, &ps.path, &pi, out, sizeof(out), &accepted,
            NGTCP2_WRITE_DATAGRAM_FLAG_NONE, 0, &v, 1, ts);
        if (n < 0) {
            if (n == NGTCP2_ERR_WRITE_MORE) { if (accepted) c->txDatagrams.pop_front(); continue; }
            break; // datagram too large / blocked — give up this round
        }
        if (accepted) c->txDatagrams.pop_front();
        if (n > 0) sendto(fd, out, (size_t)n, 0, (sockaddr*)&c->remote, c->remoteLen);
        if (!accepted) break;
    }

    for (;;) {
        // Pick the highest-priority writable stream (lowest urgency wins; ties
        // break by insertion order). This is the server-side of GW2's RFC 9218
        // priority tiers — combined with QUIC's independent streams it stops a
        // bulk transfer head-of-line-blocking per-frame state.
        int64_t sid = -1;
        OutStream* os = nullptr;
        int bestUrg = 1000;
        for (int64_t id : c->outOrder) {
            auto it = c->out.find(id);
            if (it == c->out.end()) continue;
            OutStream& o = it->second;
            if (o.blockedThisRound) continue;
            bool hasData = o.off < o.pending.size();
            bool needFin = o.finQueued && !o.finSent;
            if (!(hasData || needFin)) continue;
            int u = TierUrgency(o.cls);
            if (u < bestUrg) { bestUrg = u; sid = id; os = &o; if (u == 0) break; }
        }

        ngtcp2_vec datav{};
        uint32_t flags = NGTCP2_WRITE_STREAM_FLAG_NONE;
        if (os) {
            datav.base = os->pending.data() + os->off;
            datav.len = os->pending.size() - os->off;
            if (os->finQueued) flags |= NGTCP2_WRITE_STREAM_FLAG_FIN;
        }

        ngtcp2_ssize ndatalen = 0;
        ngtcp2_ssize n = ngtcp2_conn_writev_stream(
            c->conn, &ps.path, &pi, out, sizeof(out), &ndatalen, flags,
            sid, sid >= 0 ? &datav : nullptr, sid >= 0 ? 1 : 0, ts);

        if (n < 0) {
            if (n == NGTCP2_ERR_WRITE_MORE) {
                if (ndatalen > 0 && os) {
                    os->off += (size_t)ndatalen;
                    if (os->off >= os->pending.size() && os->finQueued) os->finSent = true;
                }
                continue;
            }
            if (n == NGTCP2_ERR_STREAM_DATA_BLOCKED || n == NGTCP2_ERR_STREAM_SHUT_WR) {
                if (os) os->blockedThisRound = true; // retry next FlushConn
                continue;
            }
            std::fprintf(stderr, "[webtransport] conn=%u writev_stream failed rv=%d (%s) — closing\n",
                         c->clientId, (int)n, ngtcp2_strerror((int)n));
            CloseConn(c);
            return;
        }

        if (ndatalen > 0 && os) {
            os->off += (size_t)ndatalen;
            if (os->off >= os->pending.size()) {
                if (os->finQueued) os->finSent = true;
                os->pending.clear();
                os->off = 0;
            }
        }
        if (n == 0) break; // nothing more to send
        sendto(fd, out, (size_t)n, 0, (sockaddr*)&c->remote, c->remoteLen);
    }

    // Reset per-round blocked flags and reap finished one-shot streams.
    for (auto it = c->out.begin(); it != c->out.end();) {
        it->second.blockedThisRound = false;
        if (it->second.finSent && it->second.pending.empty()) {
            int64_t id = it->first;
            it = c->out.erase(it);
            for (auto oit = c->outOrder.begin(); oit != c->outOrder.end(); ++oit)
                if (*oit == id) { c->outOrder.erase(oit); break; }
        } else {
            ++it;
        }
    }
}

// ───────────────────────────── network thread ───────────────────────────────

void WebTransportServerImpl::Run() {
    tlsImpl = this;
    uint8_t buf[2048];
    while (running.load()) {
        ngtcp2_tstamp now = NowNs();
        CheckCertReload(now);
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
                int rv = ngtcp2_pkt_decode_version_cid(&vc, buf, (size_t)rd, kScidLen);
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
                    // Unknown CID: only a fresh Initial may start a connection.
                    // Stray late/duplicate short-header packets land here and are
                    // dropped (ngtcp2_accept rejects non-Initials).
                    ngtcp2_pkt_hd hd;
                    if (ngtcp2_accept(&hd, buf, (size_t)rd) != 0) continue;
                    c = AcceptConn(hd, (sockaddr*)&sa, salen, ps.path);
                    if (!c) continue;
                }

                ngtcp2_pkt_info pi{};
                int rrv = ngtcp2_conn_read_pkt(c->conn, &ps.path, &pi, buf, (size_t)rd, NowNs());
                if (rrv != 0) {
                    if (rrv == NGTCP2_ERR_DRAINING || rrv == NGTCP2_ERR_DROP_CONN) {
                        // The peer sent a CONNECTION_CLOSE (or we must drop). Dump
                        // the received close — for a Chrome-initiated teardown this
                        // is exactly the error code + reason behind a JS-side
                        // "source=session, Connection lost." (GW4-c2 blocker).
                        const ngtcp2_ccerr* cc = ngtcp2_conn_get_ccerr(c->conn);
                        if (cc) {
                            std::fprintf(stderr,
                                "[webtransport] conn=%u closed by peer: ccerr type=%d code=%llu frame=0x%llx reason=\"%.*s\"\n",
                                c->clientId, (int)cc->type,
                                (unsigned long long)cc->error_code,
                                (unsigned long long)cc->frame_type,
                                (int)cc->reasonlen, cc->reason ? (const char*)cc->reason : "");
                        } else {
                            std::fprintf(stderr, "[webtransport] conn=%u dropped (rv=%d)\n",
                                         c->clientId, rrv);
                        }
                        CloseConn(c);
                    } else if (QuicLogEnabled()) {
                        std::fprintf(stderr, "[webtransport] conn=%u read_pkt rv=%d (%s)\n",
                                     c->clientId, rrv, ngtcp2_strerror(rrv));
                    }
                    continue;
                }
            }
        }

        DrainPendingTx();
        std::vector<WtConn*> snapshot;
        snapshot.reserve(conns.size());
        for (auto& [id, c] : conns) snapshot.push_back(c);
        for (WtConn* c : snapshot) {
            if (c->closed) continue;
            if (ngtcp2_conn_get_expiry(c->conn) <= NowNs()) {
                if (ngtcp2_conn_handle_expiry(c->conn, NowNs()) != 0) { CloseConn(c); continue; }
            }
            DrainPendingUni(c); // retry sends that were stream-limit-blocked
            FlushConn(c);
        }
    }
    tlsImpl = nullptr;
}

// ──────────────────────────────── public seam ───────────────────────────────

WebTransportServer::WebTransportServer() : impl_(std::make_unique<WebTransportServerImpl>()) {}
WebTransportServer::~WebTransportServer() { Shutdown(); }

bool WebTransportServer::Start(int port, const std::string& certPath, const std::string& keyPath) {
    if (!impl_->SetupTls(certPath, keyPath)) {
        std::fprintf(stderr, "[webtransport] TLS setup failed\n");
        return false;
    }
    // Dual-stack IPv6 socket (V6ONLY off) so one socket serves IPv4 and IPv6
    // clients. This matters in dev: browsers resolve `localhost` to IPv6 `::1`,
    // so an IPv4-only socket would silently never see the packets. IPv4 clients
    // arrive as v4-mapped addresses, which ngtcp2's byte-wise path handling
    // treats transparently.
    int fd = socket(AF_INET6, SOCK_DGRAM, 0);
    if (fd < 0) return false;
    // No SO_REUSEADDR: on macOS/BSD it lets a second process bind this
    // same UDP port, and the kernel then splits datagrams across both
    // sockets — the game equivalent of the TCP SO_REUSEPORT hazard (a
    // client's QUIC packets reaching a stale/zombie server). UDP has no
    // TIME_WAIT, so a dead server frees the port immediately and a fresh
    // bind needs no reuse flag. FD_CLOEXEC closes this fd on the restart
    // re-exec (execvp) so the new image rebinds cleanly (the restart path
    // does not otherwise stop this server before exec).
    fcntl(fd, F_SETFD, fcntl(fd, F_GETFD) | FD_CLOEXEC);
    int v6only = 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &v6only, sizeof(v6only));
    // Non-blocking: the recv loop must return to the flush/timer step once the
    // socket is drained (a blocking recvfrom would wedge the handshake — the
    // server would read the ClientHello and never send the ServerHello).
    {
        int fl = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    }
    sockaddr_in6 addr{};
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons((uint16_t)port);
    if (bind(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
        std::fprintf(stderr, "[webtransport] bind(:%d) failed\n", port);
        close(fd);
        return false;
    }
    if (port == 0) {
        socklen_t alen = sizeof(addr);
        if (getsockname(fd, (sockaddr*)&addr, &alen) == 0) port = ntohs(addr.sin6_port);
    }
    impl_->fd = fd;
    impl_->port = port;
    impl_->running.store(true);
    impl_->thread = std::thread([this] { impl_->Run(); });
    std::fprintf(stderr, "[webtransport] QUIC listening on udp/:%d (mode=%s certhash=%s)\n",
                 port, impl_->certMode == WtCertMode::Webpki ? "webpki" : "hashes",
                 CertHash().c_str());
    return true;
}

std::string WebTransportServer::CertHash() const {
    std::lock_guard<std::mutex> lk(impl_->certHashMutex);
    return impl_->certHashHex;
}

WtCertMode WebTransportServer::CertMode() const { return impl_->certMode; }

std::vector<std::string> WebTransportServer::CertHashes() const {
    // Webpki mode: browsers validate via the CA chain — pinning a rotating
    // CA cert would break clients on every renewal, so publish nothing.
    // (certMode is set once in SetupTls before the Run() thread starts and
    // never changes after, so it needs no guard — unlike the hash strings.)
    if (impl_->certMode == WtCertMode::Webpki) return {};
    std::vector<std::string> out;
    std::lock_guard<std::mutex> lk(impl_->certHashMutex);
    if (!impl_->certHashHex.empty()) out.push_back(impl_->certHashHex);
    if (!impl_->pendingCertHashHex.empty()) out.push_back(impl_->pendingCertHashHex);
    return out;
}

void WebTransportServer::ReloadCert() { impl_->forceReload.store(true); }

void WebTransportServer::SendStream(ClientID clientId, StreamClass cls,
                                    const uint8_t* data, size_t len, uint32_t lane) {
    if (outboundSuppressed_.load(std::memory_order_relaxed)) return;
    std::lock_guard<std::mutex> lk(impl_->txMutex);
    impl_->pendingTx.push_back({clientId, false, cls, lane, std::vector<uint8_t>(data, data + len)});
}

void WebTransportServer::BroadcastStream(StreamClass cls, const uint8_t* data, size_t len,
                                         uint32_t lane) {
    if (outboundSuppressed_.load(std::memory_order_relaxed)) return;
    std::lock_guard<std::mutex> lk(impl_->txMutex);
    impl_->pendingTx.push_back({0, true, cls, lane, std::vector<uint8_t>(data, data + len)});
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

void WebTransportServer::KickClient(ClientID clientId) {
    std::lock_guard<std::mutex> lk(impl_->txMutex);
    impl_->pendingKicks.push_back(clientId);
}

int WebTransportServer::GetClientCount() const {
    return (int)impl_->conns.size();
}

int WebTransportServer::Port() const { return impl_->port; }

void WebTransportServer::SetEchoMode(bool on) { impl_->echoMode = on; }

void WebTransportServer::Shutdown() {
    if (!impl_) return;
    if (impl_->running.exchange(false)) {
        if (impl_->thread.joinable()) impl_->thread.join();
        for (auto& [id, c] : impl_->conns) {
            if (c->qdec) nghttp3_qpack_decoder_del(c->qdec);
            if (c->qenc) nghttp3_qpack_encoder_del(c->qenc);
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
