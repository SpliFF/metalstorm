// SyncedInputJournal — the single recorded chokepoint every synced input
// passes through (PLAN-replay.md task 1, "journal completeness pass").
//
// WHY THIS EXISTS
// ---------------
// A replay (PLAN-replay §1) is `start checkpoint + the complete cause stream`.
// "Complete" is the whole claim: if one synced input escapes the recording,
// re-execution diverges and every downstream promise — `--replay --verify`,
// desync bisection, the nightly determinism regression — silently degrades
// from "proof" to "usually works". So the recording site is not a convenience
// hook sprinkled next to each handler; it is a *funnel* with two properties:
//
//   1. **One call site per tick phase.** The server tick applies external
//      inputs in exactly five places (see TickPhase). Each records once, at
//      the dispatch point, before the input is applied. Adding a new client
//      verb cannot add a new recording site — it flows through the existing
//      inbound funnel automatically.
//   2. **An exhaustive classifier.** Every ClientPayload wire verb is placed
//      in exactly one WireClass by ClassifyClientPayload(). The switch has no
//      `default:`, and test_synced_input_journal.cpp walks
//      EnumValuesClientPayload() and fails if any verb is unclassified — so a
//      new verb added to protocol.fbs breaks a test rather than quietly
//      falling out of the cause stream.
//
// WHAT IS *NOT* AN INPUT
// ----------------------
// Only inputs that originate OUTSIDE the deterministic sim are recorded.
// Commands the sim gives itself (CUnit::GiveCommand from Factory exit rally,
// StatisticalCombat retaliation, WaitCommandsAI, LuaSyncedCtrl called from a
// gadget's own callin) are *consequences* — re-execution reproduces them from
// the same starting state, and recording them would double-apply on replay.
// The boundary is therefore: did a byte from the network, an operator, an AI
// runtime or the process start-up cause this? Then it is an input.
//
// PURITY
// ------
// This module depends only on the standard library — no engine globals, no
// flatbuffers types (payload types cross the boundary as plain `uint8_t`).
// That is deliberate and matches HeadlessRun/StatsDump: it links into
// spring-tests without dragging in the sim, so the completeness guarantees
// above are covered by a plain doctest.
//
// The durable storage half (SQLite rows, zstd framing, retention) is NOT here
// — it belongs to PLAN-persistence's journal, which implements IJournal. This
// file owns the *shape* of a record and the *guarantee* that nothing is
// missing; persistence owns where the bytes land.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace syncedinput {

// ───────────────────────────── Tick phases ─────────────────────────────
// Frame number alone cannot order a journal. Two independent reasons:
//
//   * Several inputs land on the same frame (a whole DrainInbound batch),
//     and their relative order changes the result.
//   * While the sim is paused or pre-GameStart, `sim.GetFrameNum()` does not
//     advance at all, yet inbound messages keep being applied — an unbounded
//     number of inputs can share one frame stamp.
//
// So a record is ordered by (frame, phase, seq); `seq` is a per-process
// monotonic counter and is the real tiebreak. Phase is carried anyway because
// it is what a re-execution driver needs: it says *where in the tick* to
// re-inject, and phase ordering is the tick's own source order.
enum class TickPhase : uint8_t {
    /// rtcServer.DrainInbound() → ClientMessageHandler::HandleMessage.
    Inbound = 0,
    /// rtcServer.DrainDisconnects() → PlayerLeft / eventHandler.PlayerRemoved.
    Disconnect = 1,
    /// sim.SimFrame(). Reserved: the sim injects no external input today, but
    /// a restore/rollback lands here and must sort after the tick's inbound.
    SimFrame = 2,
    /// luaExecEngine drain — admin console + HTTP /api/exec.
    LuaExec = 3,
    /// streamer.Tick() — AI command drain, standing-order and directive
    /// evaluation, SendLuaRulesMsg loopback.
    Stream = 4,
};

const char* TickPhaseName(TickPhase p);

// ─────────────────────────── Input classes ────────────────────────────
enum class InputKind : uint8_t {
    /// Raw ClientMessage wire bytes; `subKind` carries the ClientPayload type.
    /// Recording the undecoded frame is deliberate — replay re-feeds it
    /// through the identical HandleMessage path, so the replayed run cannot
    /// drift from the live one through a decode difference.
    ClientMessage = 0,
    /// A client dropped; payload is the one-byte leave reason.
    PlayerDisconnect = 1,
    /// Admin console / HTTP exec: arbitrary Lua against the synced state.
    LuaExec = 2,
    /// One drained AI command (AICommandQueue). AI output is an input to the
    /// sim: the AI runtime is a separate VM whose scheduling is not part of
    /// the synced state, so its commands must be recorded, not re-derived.
    AICommand = 3,
    /// Game start: seed, roster and setup that anchor the whole stream.
    GameStart = 4,
    /// A GM/persistence restore relocated the sim to another frame. Not an
    /// input the sim consumes, but the journal must record the discontinuity
    /// or a replay would re-apply the post-restore stream to the wrong state.
    SnapshotRestore = 5,
    /// The identity a successful AuthRequest resolved to (PLAN-replay T2-a).
    /// Not an input either — it is the ANSWER the live run got from the
    /// accounts database, recorded because a re-execution cannot ask the same
    /// question. See AuthIdentity below.
    AuthIdentity = 6,
};

const char* InputKindName(InputKind k);

/// The outcome of one successful AuthRequest (PLAN-replay §7.5 T2-a).
///
/// WHY THIS EXISTS
/// ---------------
/// Every other record in the stream is an input the server *received*. This
/// one is an answer the server *looked up*: `AuthRequest` carries a session
/// token or a password, and turning either into (account id, username, role)
/// is a query against the accounts database. A replay does not have that
/// database — a replica need not carry the `sessions` row, and by the time a
/// campaign game is replayed the token is expired by construction — so
/// re-running the query is not merely inconvenient, it answers differently.
///
/// The decision T2-a records (PLAN-replay §7.10): **for a re-execution the
/// recorded stream, not the database, is the identity authority.** So the
/// resolution is recorded next to the message that produced it, and replay
/// re-enters the session layer from here instead of from `db`.
///
/// Only the DB-derived half is authoritative on replay. `team` is derived from
/// the launch roster, which the replay header reproduces exactly, so it is
/// recorded as a CROSS-CHECK: a mismatch means the replay is about to
/// authorise every later PlayerCommand against a different team than the
/// recording did, and that is caught here rather than as an unexplained hash
/// divergence minutes later.
struct AuthIdentity {
    int64_t     userId    = 0;    ///< accounts.id — DB-derived, authoritative
    std::string username;         ///< DB-derived: a token reconnect sends none
    std::string role;             ///< effective role, incl. the spectator override
    int32_t     team      = -1;   ///< roster-derived; replay re-derives and compares
    int32_t     playerNum = -1;   ///< allocation order; replay re-derives and compares
    bool        spectator = false;
};

/// Encode/decode for AuthIdentity's record payload. Little-endian, fixed-width
/// or length-prefixed, same dumb framing as ReplayFile — deliberately free of
/// flatbuffers so the round-trip is doctest-covered without the wire schema.
std::vector<uint8_t> EncodeAuthIdentity(const AuthIdentity& id);
bool DecodeAuthIdentity(const std::vector<uint8_t>& payload, AuthIdentity& out);

/// Where a ClientPayload verb sits with respect to the cause stream. Exactly
/// one class per verb; see ClassifyClientPayload.
enum class WireClass : uint8_t {
    /// Mutates synced sim state. MUST be journaled.
    Synced = 0,
    /// Session/roster/pre-game state that shapes the synced world indirectly
    /// (which player number a client owns, which team it may command). Also
    /// journaled: the replay header's roster is not enough on its own,
    /// because these can arrive mid-game.
    Setup = 1,
    /// Per-client view state — viewport, selection, path preview, chat-style
    /// relays. Never journaled; dropping them cannot change the sim.
    Unsynced = 2,
    /// Parsed and deliberately refused (ClientMessageHandler's ungated-verb
    /// block, PLAN-security-hardening task 11), or the NONE tag. Never
    /// journaled *because the server never applies them* — if one is ever
    /// wired up it must move to Synced or Setup, and the classifier switch is
    /// where that decision is forced.
    Ignored = 3,
};

const char* WireClassName(WireClass c);

/// Exhaustive over the ClientPayload union. `payloadType` is the flatbuffers
/// tag value (SpringWeb::ClientPayload_*), passed as a plain integer to keep
/// this module free of generated headers. Unknown/out-of-range tags classify
/// as Ignored — the server rejects them before dispatch anyway.
WireClass ClassifyClientPayload(uint8_t payloadType);

/// True when `payloadType` is a tag the classifier has an explicit case for.
/// The completeness test walks EnumValuesClientPayload() through this: a verb
/// added to protocol.fbs without a classifier case fails there, which is the
/// tripwire that keeps the cause stream complete over time.
bool IsKnownClientPayload(uint8_t payloadType);

/// Convenience: Synced and Setup are recorded, the other two are not.
bool ShouldRecordClientPayload(uint8_t payloadType);

// ────────────────────────────── Records ───────────────────────────────
struct Record {
    uint64_t  seq      = 0;     ///< process-monotonic; the total order
    int32_t   frame    = 0;     ///< sim frame the input was applied at
    TickPhase phase    = TickPhase::Inbound;
    InputKind kind     = InputKind::ClientMessage;
    uint8_t   subKind  = 0;     ///< ClientPayload tag when kind == ClientMessage
    int32_t   playerId = -1;    ///< -1 = unattributed (server/operator/test AI)
    /// Transport-level source id for kind == ClientMessage; 0 otherwise.
    ///
    /// playerId is NOT sufficient for re-execution: a client's first messages
    /// (Handshake, AuthRequest, the room/enlist verbs) arrive *before* it owns
    /// a player number, so they all record playerId == -1 and become
    /// indistinguishable from each other and from server-side input. The
    /// session layer that the replay must re-enter is keyed on the connection,
    /// so the connection id is what has to survive into the record — replay
    /// re-feeds each message under its recorded clientId and the handler's
    /// session/handshake/rate-limit state tracks the same identities it did
    /// live. (PLAN-replay task 2.)
    uint32_t  clientId = 0;
    std::vector<uint8_t> payload;
};

/// The sink a journal implementation provides. PLAN-persistence's phase-2
/// journal implements this; MemoryJournal below is the in-process form the
/// replay packer (PLAN-replay task 3) and the audit route read.
class IJournal {
public:
    virtual ~IJournal() = default;
    /// False → the funnel still classifies and counts, but builds no payload.
    virtual bool Enabled() const = 0;
    virtual void Append(Record&& r) = 0;
};

/// Default sink: records nothing. The funnel's counters still run, so an
/// operator can see the cause-stream volume without paying for storage.
class NullJournal : public IJournal {
public:
    bool Enabled() const override { return false; }
    void Append(Record&&) override {}
};

/// Bounded in-memory ring. Used by the doctests, by `--journal-audit`, and as
/// the reference implementation persistence's durable journal must match.
/// When the cap is hit the OLDEST record is dropped and `dropped` counts it —
/// a truncated tail is the E1 case PLAN-replay §6 already specifies, and it
/// must be visible rather than silently produce a short replay.
class MemoryJournal : public IJournal {
public:
    explicit MemoryJournal(size_t maxRecords = 100000) : cap(maxRecords) {}

    bool Enabled() const override { return true; }
    void Append(Record&& r) override;

    const std::vector<Record>& Records() const { return records; }
    uint64_t Dropped() const { return dropped; }
    void Clear() { records.clear(); dropped = 0; }

private:
    std::vector<Record> records;
    size_t   cap;
    uint64_t dropped = 0;
};

// ────────────────────────────── The funnel ─────────────────────────────
/// Per-kind tallies. Maintained whether or not a journal is attached, so the
/// completeness audit is available on any running server.
struct Counters {
    uint64_t seen      = 0;   ///< inputs offered to the funnel
    uint64_t recorded  = 0;   ///< classified as journal-worthy
    uint64_t appended  = 0;   ///< actually handed to an enabled journal
    uint64_t skipped   = 0;   ///< classified Unsynced/Ignored
    uint64_t byKind[7] = {0}; ///< recorded, indexed by InputKind
};

/// The recording funnel. One instance per game server process; the tests
/// construct their own. Not thread-safe by design: every call site is on the
/// sim thread inside server_main's tick (DrainInbound already hands the
/// network thread's messages over), and adding a lock would hide a caller
/// that had wandered off-thread.
class Recorder {
public:
    void SetJournal(IJournal* j) { journal = j; }
    IJournal* GetJournal() const { return journal; }
    bool Enabled() const { return journal != nullptr && journal->Enabled(); }

    /// Start a tick: stamps subsequent records with `frame`, phase Inbound.
    void BeginTick(int32_t frame) { curFrame = frame; curPhase = TickPhase::Inbound; }
    void SetPhase(TickPhase p) { curPhase = p; }
    int32_t Frame() const { return curFrame; }
    TickPhase Phase() const { return curPhase; }

    const Counters& Stats() const { return counters; }
    uint64_t NextSeq() const { return seq; }

    /// The inbound funnel — ONE call covering every client verb. Returns true
    /// if the message was journal-worthy (whether or not a journal is
    /// attached), so the caller can log/assert on coverage. `clientId` is the
    /// transport connection the bytes arrived on; see Record::clientId for why
    /// playerId alone cannot stand in for it.
    bool RecordClientMessage(uint8_t payloadType, int32_t playerId,
                             uint32_t clientId,
                             const uint8_t* data, size_t size);

    bool RecordDisconnect(int32_t playerId, uint8_t reason);
    bool RecordLuaExec(int32_t playerId, const std::string& scope,
                       const std::string& code);
    /// `blob` is the AICommand POD as drained — opaque here on purpose; the
    /// journal stores bytes and the replay driver re-pushes them.
    bool RecordAICommand(int32_t playerId, const uint8_t* data, size_t size);
    bool RecordGameStart(const std::string& setupSummary);
    bool RecordSnapshotRestore(int32_t fromFrame, int32_t toFrame);
    /// Record what a successful AuthRequest on `clientId` resolved to. Emitted
    /// immediately after the resolution, so it follows its own AuthRequest
    /// record in seq order — replay indexes these at LOAD time rather than
    /// consuming them in stream order, precisely because the answer has to be
    /// available while the question is being re-asked (see ReplayPlayer).
    bool RecordAuthIdentity(uint32_t clientId, const AuthIdentity& id);

private:
    bool Emit(InputKind kind, uint8_t subKind, int32_t playerId,
              uint32_t clientId, const uint8_t* data, size_t size);

    IJournal* journal  = nullptr;
    int32_t   curFrame = 0;
    TickPhase curPhase = TickPhase::Inbound;
    uint64_t  seq      = 0;
    Counters  counters;
};

/// Process-wide recorder (one server process = one game).
Recorder& Journal();

/// Human-readable audit summary — the `--journal-audit` shutdown line and the
/// /api/journal payload both render from this.
std::string FormatAudit(const Counters& c);

} // namespace syncedinput
