// SyncedInputJournal — see header for the design and the completeness claim.

#include "SyncedInputJournal.h"

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace syncedinput {

namespace {

// Mirror of the ClientPayload union tags (protocol.fbs). Kept here rather
// than including protocol_generated.h so this module stays pure and links
// into spring-tests without the flatbuffers/engine surface.
//
// The mirror is not trusted: test_synced_input_journal.cpp includes the
// generated header and asserts, tag by tag, that these values agree AND that
// every value in EnumValuesClientPayload() is known to the classifier below.
// Renumbering or adding a verb therefore fails a test instead of silently
// dropping that verb out of the cause stream.
enum Tag : uint8_t {
    NONE = 0,
    Handshake = 1,
    AuthRequest = 2,
    PlayerCommand = 3,
    ViewportUpdate = 4,
    Ping = 5,
    ChatSend = 6,
    Ack = 7,
    ReconnectRequest = 8,
    RoomCreate = 9,
    RoomJoin = 10,
    RoomLeave = 11,
    RoomEnlist = 12,
    RoomTeamSelect = 13,
    RoomReady = 14,
    RoomKick = 15,
    RoomStartGame = 16,
    RoomEndGame = 17,
    RoomAddAI = 18,
    RoomRemoveAI = 19,
    AIListRequest = 20,
    GameListRequest = 21,
    RoomSetStartPos = 22,
    RoomCloseRoom = 23,
    RoomSetAITeam = 24,
    LogIngest = 25,
    LogSubscribe = 26,
    LogUnsubscribe = 27,
    ConsoleCommand = 28,
    LuaRulesMsg = 29,
    PlayerCommandBatch = 30,
    SelectionState = 31,
    PathRequest = 32,
    PathRequestCancel = 33,
    StandingOrderCreate = 34,
    StandingOrderUpdate = 35,
    StandingOrderRemove = 36,
    LuaUIMsg = 37,
    PlayerLeaveIntent = 38,
    OrgGroupCreate = 39,
    OrgGroupUpdate = 40,
    OrgGroupDisband = 41,
    GroupDirective = 42,
    GroupDirectiveRemove = 43,
    GroupPosture = 44,
    ReplayControl = 45,
    // Not a tag — the exclusive upper bound used by IsKnownClientPayload.
    TagCount = 46,
};

} // namespace

const char* TickPhaseName(TickPhase p) {
    switch (p) {
        case TickPhase::Inbound:    return "inbound";
        case TickPhase::Disconnect: return "disconnect";
        case TickPhase::SimFrame:   return "simframe";
        case TickPhase::LuaExec:    return "luaexec";
        case TickPhase::Stream:     return "stream";
    }
    return "?";
}

const char* InputKindName(InputKind k) {
    switch (k) {
        case InputKind::ClientMessage:    return "client-message";
        case InputKind::PlayerDisconnect: return "player-disconnect";
        case InputKind::LuaExec:          return "lua-exec";
        case InputKind::AICommand:        return "ai-command";
        case InputKind::GameStart:        return "game-start";
        case InputKind::SnapshotRestore:  return "snapshot-restore";
        case InputKind::AuthIdentity:     return "auth-identity";
    }
    return "?";
}

namespace {

void PutU16(std::vector<uint8_t>& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v & 0xFF));
    b.push_back(static_cast<uint8_t>((v >> 8) & 0xFF));
}

void PutStr(std::vector<uint8_t>& b, const std::string& s) {
    // Truncation would silently change an identity, so an over-long field is a
    // refusal at decode time rather than a quiet cut here; usernames and roles
    // are bounded far below 64 KiB by the accounts schema.
    PutU16(b, static_cast<uint16_t>(std::min<size_t>(s.size(), 0xFFFF)));
    b.insert(b.end(), s.begin(), s.begin() + std::min<size_t>(s.size(), 0xFFFF));
}

bool TakeBytes(const std::vector<uint8_t>& b, size_t& off, void* dst, size_t n) {
    if (off + n > b.size()) return false;
    std::memcpy(dst, b.data() + off, n);
    off += n;
    return true;
}

bool TakeStr(const std::vector<uint8_t>& b, size_t& off, std::string& out) {
    uint8_t lo = 0, hi = 0;
    if (!TakeBytes(b, off, &lo, 1) || !TakeBytes(b, off, &hi, 1)) return false;
    const size_t n = static_cast<size_t>(lo) | (static_cast<size_t>(hi) << 8);
    if (off + n > b.size()) return false;
    out.assign(reinterpret_cast<const char*>(b.data() + off), n);
    off += n;
    return true;
}

}  // namespace

std::vector<uint8_t> EncodeAuthIdentity(const AuthIdentity& id) {
    std::vector<uint8_t> b;
    b.reserve(32 + id.username.size() + id.role.size());
    const int64_t uid = id.userId;
    const uint8_t* p = reinterpret_cast<const uint8_t*>(&uid);
    b.insert(b.end(), p, p + sizeof(uid));
    const int32_t nums[2] = {id.team, id.playerNum};
    p = reinterpret_cast<const uint8_t*>(nums);
    b.insert(b.end(), p, p + sizeof(nums));
    b.push_back(id.spectator ? 1 : 0);
    PutStr(b, id.username);
    PutStr(b, id.role);
    return b;
}

bool DecodeAuthIdentity(const std::vector<uint8_t>& payload, AuthIdentity& out) {
    size_t off = 0;
    int32_t nums[2] = {-1, -1};
    uint8_t spec = 0;
    if (!TakeBytes(payload, off, &out.userId, sizeof(out.userId))) return false;
    if (!TakeBytes(payload, off, nums, sizeof(nums))) return false;
    if (!TakeBytes(payload, off, &spec, 1)) return false;
    if (!TakeStr(payload, off, out.username)) return false;
    if (!TakeStr(payload, off, out.role)) return false;
    out.team      = nums[0];
    out.playerNum = nums[1];
    out.spectator = spec != 0;
    return true;
}

const char* WireClassName(WireClass c) {
    switch (c) {
        case WireClass::Synced:   return "synced";
        case WireClass::Setup:    return "setup";
        case WireClass::Unsynced: return "unsynced";
        case WireClass::Ignored:  return "ignored";
    }
    return "?";
}

bool IsKnownClientPayload(uint8_t payloadType) {
    return payloadType < TagCount;
}

WireClass ClassifyClientPayload(uint8_t payloadType) {
    // Deliberately NO `default:` — every tag is named. The enum is uint8_t so
    // the compiler still wants the out-of-range return after the switch, but
    // a *newly added named tag* trips -Wswitch here and the coverage test in
    // test_synced_input_journal.cpp regardless.
    switch (static_cast<Tag>(payloadType)) {
        // ── Synced: these reach the sim ──────────────────────────────────
        // Unit orders, routed straight to CCommandAI::GiveCommand.
        case PlayerCommand:
        case PlayerCommandBatch:
        // Relayed into synced LuaRules (gadget:RecvLuaMsg) — the game's own
        // scripted state changes ride this.
        case LuaRulesMsg:
        // Admin console: arbitrary Lua against the synced state. The single
        // most destructive input class there is, and the one most easily
        // forgotten in a cause stream.
        case ConsoleCommand:
        // Standing orders: the manager is evaluated every tick and issues
        // real commands, so its mutations are inputs.
        case StandingOrderCreate:
        case StandingOrderUpdate:
        case StandingOrderRemove:
        // Macro C2: org groups + directives, same evaluator discipline.
        case OrgGroupCreate:
        case OrgGroupUpdate:
        case OrgGroupDisband:
        case GroupDirective:
        case GroupDirectiveRemove:
        case GroupPosture:
            return WireClass::Synced;

        // ── Setup: shapes who may cause what ─────────────────────────────
        // The C1 protocol gate. It carries no state of its own, which is why
        // this sat in Unsynced until 2026-08-04 — but it is the gate that
        // decides whether the AuthRequest below is admissible at all
        // (ClientMessageHandler refuses auth from a connection that never
        // handshook), so a stream that drops it cannot re-enter its own
        // authentications: the replayed AuthRequest is rejected for want of a
        // handshake and the game runs on with no human player, a different
        // team leader and a roster divergence at GameStart. Observed exactly
        // that way on a real Metalstorm recording, PLAN-replay §7.10.
        // Recording it also means a version mismatch that was REJECTED live is
        // rejected identically on replay, which the "shapes who may cause
        // what" rule wants and a synthesised handshake would silently undo.
        case Handshake:
        // Auth assigns the player number and team a later PlayerCommand is
        // authorised against; without it the routing of the synced stream is
        // not reconstructible.
        case AuthRequest:
        // Room/roster verbs on the game server. RoomEnlist in particular can
        // move a session between spectator and a team mid-session.
        case RoomCreate:
        case RoomJoin:
        case RoomLeave:
        case RoomEnlist:
        case RoomTeamSelect:
        case RoomReady:
        case RoomKick:
        case RoomStartGame:
        // Records the *reason* an imminent disconnect carries (detach vs
        // quit), which PlayerRemoved hands to gadgets.
        case PlayerLeaveIntent:
            return WireClass::Setup;

        // ── Unsynced: per-client view state ──────────────────────────────
        case Ping:               // RTT only
        case ViewportUpdate:     // server-side visibility filtering input
        case SelectionState:     // drives HUD/streaming priority, not the sim
        case PathRequest:        // read-only IPathManager query
        case PathRequestCancel:
        case LuaUIMsg:           // player→player widget relay; never synced
            return WireClass::Unsynced;

        // ── Ignored: parsed and refused, or the empty tag ────────────────
        // ClientMessageHandler's ungated-verb block (PLAN-security-hardening
        // task 11) drops all of these without applying anything. If one is
        // ever wired up, it must be moved to Synced or Setup — this switch is
        // where that decision is forced.
        case NONE:
        case ChatSend:
        case Ack:
        case ReconnectRequest:
        case RoomEndGame:
        case RoomAddAI:
        case RoomRemoveAI:
        case AIListRequest:
        case GameListRequest:
        case RoomSetStartPos:
        case RoomCloseRoom:
        case RoomSetAITeam:
        case LogIngest:
        case LogSubscribe:
        case LogUnsubscribe:
        // Replay playback controls (PLAN-replay task 4b). `Ignored` is the
        // classification, not a shrug: a control that changes which frame the
        // recorded feed is at, how fast it advances or whether it advances is
        // not an input to the simulation and must never enter a cause stream —
        // journalling one would make "pause" part of the recording and replay
        // it back at whoever watches next. It reaches a handler only while
        // replay::IsReplaying(); on a live server ClientMessageHandler drops
        // it exactly like the ungated verbs above.
        case ReplayControl:
            return WireClass::Ignored;

        case TagCount:
            break;
    }
    // Out-of-range tag: the flatbuffers verifier rejects these before
    // dispatch, so nothing is applied and nothing needs recording.
    return WireClass::Ignored;
}

bool ShouldRecordClientPayload(uint8_t payloadType) {
    const WireClass c = ClassifyClientPayload(payloadType);
    return c == WireClass::Synced || c == WireClass::Setup;
}

// ─────────────────────────────── MemoryJournal ─────────────────────────

void MemoryJournal::Append(Record&& r) {
    if (cap > 0 && records.size() >= cap) {
        // Drop the oldest. erase(begin()) is O(n) but the audit ring is a
        // diagnostic path, not the sim hot loop, and keeping a plain vector
        // means Records() hands out the stream in order with no unwrapping.
        records.erase(records.begin());
        ++dropped;
    }
    records.push_back(std::move(r));
}

// ──────────────────────────────── Recorder ─────────────────────────────

bool Recorder::Emit(InputKind kind, uint8_t subKind, int32_t playerId,
                    uint32_t clientId, const uint8_t* data, size_t size) {
    ++counters.recorded;
    counters.byKind[static_cast<size_t>(kind)]++;
    if (journal == nullptr || !journal->Enabled())
        return true;   // journal-worthy, just not being stored right now

    Record r;
    r.seq      = ++seq;
    r.frame    = curFrame;
    r.phase    = curPhase;
    r.kind     = kind;
    r.subKind  = subKind;
    r.playerId = playerId;
    r.clientId = clientId;
    if (data != nullptr && size > 0)
        r.payload.assign(data, data + size);
    journal->Append(std::move(r));
    ++counters.appended;
    return true;
}

bool Recorder::RecordClientMessage(uint8_t payloadType, int32_t playerId,
                                   uint32_t clientId,
                                   const uint8_t* data, size_t size) {
    ++counters.seen;
    if (!ShouldRecordClientPayload(payloadType)) {
        ++counters.skipped;
        return false;
    }
    return Emit(InputKind::ClientMessage, payloadType, playerId, clientId,
                data, size);
}

bool Recorder::RecordDisconnect(int32_t playerId, uint8_t reason) {
    ++counters.seen;
    return Emit(InputKind::PlayerDisconnect, reason, playerId, 0, nullptr, 0);
}

bool Recorder::RecordLuaExec(int32_t playerId, const std::string& scope,
                             const std::string& code) {
    ++counters.seen;
    // Payload is "<scope>\0<code>" — scope selects which Lua state the code
    // runs in, so it is part of the input, not metadata.
    std::string blob = scope;
    blob.push_back('\0');
    blob += code;
    return Emit(InputKind::LuaExec, 0, playerId, 0,
                reinterpret_cast<const uint8_t*>(blob.data()), blob.size());
}

bool Recorder::RecordAICommand(int32_t playerId, const uint8_t* data, size_t size) {
    ++counters.seen;
    return Emit(InputKind::AICommand, 0, playerId, 0, data, size);
}

bool Recorder::RecordGameStart(const std::string& setupSummary) {
    ++counters.seen;
    return Emit(InputKind::GameStart, 0, -1, 0,
                reinterpret_cast<const uint8_t*>(setupSummary.data()),
                setupSummary.size());
}

bool Recorder::RecordSnapshotRestore(int32_t fromFrame, int32_t toFrame) {
    ++counters.seen;
    const int32_t frames[2] = {fromFrame, toFrame};
    return Emit(InputKind::SnapshotRestore, 0, -1, 0,
                reinterpret_cast<const uint8_t*>(frames), sizeof(frames));
}

bool Recorder::RecordAuthIdentity(uint32_t clientId, const AuthIdentity& id) {
    ++counters.seen;
    const std::vector<uint8_t> blob = EncodeAuthIdentity(id);
    return Emit(InputKind::AuthIdentity, id.spectator ? 1 : 0, id.playerNum,
                clientId, blob.data(), blob.size());
}

Recorder& Journal() {
    static Recorder instance;
    return instance;
}

std::string FormatAudit(const Counters& c) {
    char buf[512];
    std::snprintf(buf, sizeof(buf),
        "seen=%llu recorded=%llu appended=%llu skipped=%llu "
        "[client-message=%llu disconnect=%llu lua-exec=%llu ai-command=%llu "
        "game-start=%llu snapshot-restore=%llu auth-identity=%llu]",
        (unsigned long long)c.seen, (unsigned long long)c.recorded,
        (unsigned long long)c.appended, (unsigned long long)c.skipped,
        (unsigned long long)c.byKind[0], (unsigned long long)c.byKind[1],
        (unsigned long long)c.byKind[2], (unsigned long long)c.byKind[3],
        (unsigned long long)c.byKind[4], (unsigned long long)c.byKind[5],
        (unsigned long long)c.byKind[6]);
    return std::string(buf);
}

} // namespace syncedinput
