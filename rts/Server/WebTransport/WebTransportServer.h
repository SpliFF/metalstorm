// WebTransportServer — game-stream transport over HTTP/3 / WebTransport (QUIC).
//
// Stage 0 (PLAN-game-worker.md) replaces the WebRTC data-channel transport
// (WebRTCServer) with WebTransport so the connection can live inside the
// game-processor worker (RTCPeerConnection is main-thread-only) and so QUIC's
// independent streams + RFC 9218 priorities stop low-priority bulk (decals,
// heightmap) head-of-line-blocking per-frame entity state — which the single
// WebRTC SCTP association cannot cleanly do.
//
// The seam deliberately mirrors WebRTCServer so server_main.cpp swaps in with
// minimal churn: SendReliable/SendUnreliable/Broadcast*/DrainInbound/
// DrainDisconnects/GetClientCount all carry over. It is *richer* in one way —
// the GW2 priority tiers are exposed via StreamClass + SendStream/BroadcastStream
// so the state-streaming sites can target Vision/Bulk tiers explicitly.
//
// Transport mapping (PLAN-game-worker.md GW2 + PLAN-metalstorm-wire.md W1):
//
//   Tier            StreamClass  Carrier                 Urgency  Envelopes / Topics
//   0 Control       Control      reliable bidi stream    0        0x01 FB, ACKs, chat
//                                                                  Per-topic EVENT lanes (W1):
//                                                                    lane 0: combat events, volleys, projectiles, sounds
//                                                                    lane 1: rulesParams (game/team)
//                                                                    lane 2: orders/directives (future)
//                                                                    lane 4: GameInfo, game-over, player join/leave
//   1 Per-frame     State        newest-wins uni stream  1        0x02/0x03 entity, 0x05 piece
//   2 Vision        Vision       reliable uni stream      3        0x07 LOS, 0x06 build-activity
//   3 Bulk          Bulk         reliable uni stream      5        0x08 decals (lane 3), 0x09 heightmap, blobs
//   (datagram)      Datagram     unreliable datagram      —        future tiny self-contained signals
//
// "newest-wins" (State): on a new snapshot, RESET_STREAM any in-flight prior
// State stream (stale positions are worthless) and open a fresh one. This gives
// datagram-like skip-stale behaviour without app-level fragmentation, since
// entity snapshots (6-8 KB) exceed the ~1200 B datagram limit.
//
// Per-topic EVENT lanes (W1): distinct lane values on Control/Vision/Bulk tiers
// create independent QUIC streams, preventing head-of-line blocking. A lost/
// retransmitted bulk packet (defs, decals) never delays a combat event or
// rulesParams update. See StateStreamer::kEventLane* constants.

#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

using ClientID = uint32_t;

struct InboundMessage;        // from NetworkServer.h
struct WebTransportServerImpl; // QUIC/ngtcp2 implementation (WebTransportServer.cpp)

/// Priority/reliability tier a payload is sent on. Values are the wire-stable
/// ordering used by the client GameTransport class taxonomy
/// (control/state/vision/bulk/datagram — see client/src/core/transport.ts).
enum class StreamClass : uint8_t {
    Control  = 0, // reliable, ordered, urgency 0 — never dropped
    State    = 1, // newest-wins unreliable-ish, urgency 1 — skip-stale
    Vision   = 2, // reliable, urgency 3
    Bulk     = 3, // reliable, urgency 5 — must never block Control/State
    Datagram = 4, // unreliable datagram (<~1200 B)
};

/// PLAN-security-hardening.md task 5: which cert-provisioning mode the
/// endpoint is running in, mirroring the accepted dual-mode design.
enum class WtCertMode : uint8_t {
    Hashes = 0, // no --wt-cert/--wt-key given: self-signed rolling pair, hashes published
    Webpki = 1, // --wt-cert/--wt-key given: CA cert, browsers validate via WebPKI, no hashes published
};

class WebTransportServer {
public:
    WebTransportServer();
    ~WebTransportServer();

    /// Bind the QUIC UDP socket on `port` and start the network thread.
    /// `certPath`/`keyPath` are filesystem paths to PEM files (e.g. a Let's
    /// Encrypt fullchain + privkey); if either is empty the endpoint runs in
    /// `Hashes` mode: it self-generates a rolling pair of ECDSA certs
    /// (<=14 day validity, the WebTransport spec cap for
    /// serverCertificateHashes) and rotates at half-life. If both are given
    /// it runs in `Webpki` mode: the cert is loaded directly and reloaded
    /// whenever its mtime changes (hourly poll) or ReloadCert() is called
    /// explicitly (e.g. a certbot deploy-hook) — see CertMode()/CertHashes().
    bool Start(int port, const std::string& certPath = "", const std::string& keyPath = "");

    /// SHA-256 of the currently *active* DER cert (lower-case hex).
    std::string CertHash() const;

    /// Which mode the endpoint is running in.
    WtCertMode CertMode() const;

    /// Hashes to publish via /api/wt/info for serverCertificateHashes pinning.
    /// Empty in Webpki mode (browsers validate via the CA chain instead — a
    /// rotating CA cert can't be pinned without breaking clients on renewal).
    /// In Hashes mode: 1 or 2 hex SHA-256 hashes — the active cert plus the
    /// already-generated "next" cert, so a client holding a stale
    /// /api/wt/info answer can still connect across a rotation.
    std::vector<std::string> CertHashes() const;

    /// Force an immediate reload/rotation check outside the hourly poll —
    /// Webpki mode re-stats and reloads the cert/key files unconditionally;
    /// Hashes mode promotes the pending cert immediately instead of waiting
    /// for half-life. Just sets an atomic flag the network thread's own loop
    /// consumes (safe to call from any thread) — but do NOT wire this to an
    /// OS signal handler: in testing, delivering a signal to this process
    /// while a Webpki-mode cert is loaded reproducibly corrupted OpenSSL's
    /// heap state (crash at process-exit cleanup) regardless of whether this
    /// method was ever actually invoked — a signal-delivery/OpenSSL
    /// interaction, not a bug in this reload logic itself (the hourly poll
    /// exercises the identical reload code with no signal involved and is
    /// safe). See PLAN-security-hardening.md task 5 and docs/deployment.md.
    void ReloadCert();

    /// Send a payload to one client on a given tier.
    ///
    /// `lane` selects the newest-wins lane for the State tier: each lane keeps
    /// its own in-flight stream, so a new send only RESET_STREAMs the prior send
    /// *on the same lane*. Distinct logical State streams (entity vs. piece) MUST
    /// use distinct lanes or they clobber each other — the caller sends several
    /// State messages per tick and a shared lane would reset the earlier ones
    /// before they ever transmit. Ignored for non-State tiers.
    void SendStream(ClientID clientId, StreamClass cls, const uint8_t* data, size_t len,
                    uint32_t lane = 0);

    /// Send a payload to all connected clients on a given tier. See SendStream
    /// for `lane`.
    void BroadcastStream(StreamClass cls, const uint8_t* data, size_t len, uint32_t lane = 0);

    // --- WebRTCServer-compatible convenience wrappers (minimal server_main churn) ---
    void SendReliable(ClientID clientId, const uint8_t* data, size_t len) {
        SendStream(clientId, StreamClass::Control, data, len);
    }
    void SendUnreliable(ClientID clientId, const uint8_t* data, size_t len, uint32_t lane = 0) {
        SendStream(clientId, StreamClass::State, data, len, lane);
    }
    void BroadcastReliable(const uint8_t* data, size_t len) {
        BroadcastStream(StreamClass::Control, data, len);
    }
    void BroadcastUnreliable(const uint8_t* data, size_t len, uint32_t lane = 0) {
        BroadcastStream(StreamClass::State, data, len, lane);
    }

    /// Drain inbound application messages (decoded from WebTransport streams +
    /// datagrams). Same contract the sim loop already drains for WebRTC.
    std::vector<InboundMessage> DrainInbound();

    /// Drain client IDs whose session closed since the last call.
    std::vector<ClientID> DrainDisconnects();

    /// Force-disconnect one client (PLAN-gm-tools GM `kick`). Thread-safe:
    /// queues the id; the network thread closes the QUIC connection, which
    /// funnels into the same DrainDisconnects() teardown as an organic drop
    /// (PlayerLeft broadcast + session removal). No-op if the id isn't
    /// connected. Callable from the sim thread.
    void KickClient(ClientID clientId);

    /// Number of established WebTransport sessions.
    int GetClientCount() const;

    /// The UDP port the QUIC socket is bound to (0 until Start succeeds).
    int Port() const;

    /// Echo mode (GW1 de-risk harness only): instead of queueing inbound to
    /// DrainInbound(), immediately echo each application message back to the
    /// sender on the same class. Off by default. Must be set before Start().
    void SetEchoMode(bool on);

    /// Stop the network thread and close all sessions.
    void Shutdown();

private:
    std::unique_ptr<WebTransportServerImpl> impl_;
};
