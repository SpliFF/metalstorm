// Tests for the synced-input journal funnel (PLAN-replay task 1).
//
// The point of these tests is not that the Recorder stores structs correctly —
// it is that the CLASSIFIER CANNOT SILENTLY FALL BEHIND protocol.fbs. The
// replay guarantee ("re-execution reproduces the state-hash track exactly")
// rests entirely on the cause stream being complete, and the way that quietly
// breaks in six months' time is somebody adding a wire verb and nobody
// noticing it never got journaled. The coverage test below is the tripwire.

#include <doctest/doctest.h>

#include "Server/SyncedInputJournal.h"
#include "protocol_generated.h"

#include <set>
#include <string>

using namespace syncedinput;

// ───────────────────── The completeness tripwire ──────────────────────

TEST_CASE("every ClientPayload verb is classified") {
    // Walks the generated union tag list. A verb added to protocol.fbs without
    // a case in ClassifyClientPayload lands here as a hard failure naming the
    // offending verb, which is what forces the "is this a synced input?"
    // decision to be made deliberately.
    for (const auto v : SpringWeb::EnumValuesClientPayload()) {
        const uint8_t tag = static_cast<uint8_t>(v);
        INFO("verb: " << SpringWeb::EnumNameClientPayload(v) << " (tag " << (int)tag << ")");
        CHECK(IsKnownClientPayload(tag));
    }
}

TEST_CASE("the classifier's tag mirror matches the generated enum") {
    // ClassifyClientPayload works off a hand-written mirror of the union tags
    // (SyncedInputJournal.cpp keeps the module free of generated headers).
    // Renumbering the union — which flatbuffers does whenever a member is
    // removed rather than deprecated — would silently reassign every
    // classification. Spot-check the boundaries plus one verb from each class.
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_NONE) == WireClass::Ignored);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_PlayerCommand) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_PlayerCommandBatch) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_LuaRulesMsg) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_ConsoleCommand) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_StandingOrderCreate) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_GroupDirective) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_GroupPosture) == WireClass::Synced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_AuthRequest) == WireClass::Setup);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_RoomEnlist) == WireClass::Setup);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_PlayerLeaveIntent) == WireClass::Setup);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_ViewportUpdate) == WireClass::Unsynced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_SelectionState) == WireClass::Unsynced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_LuaUIMsg) == WireClass::Unsynced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_Ping) == WireClass::Unsynced);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_ChatSend) == WireClass::Ignored);
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_LogIngest) == WireClass::Ignored);
    // Replay playback controls (task 4b). `Ignored` is a load-bearing
    // classification, not a leftover: journalling a control that changes which
    // frame the FEED is at would put "pause" into the cause stream and replay
    // it back at the next watcher. If someone ever moves this to Synced or
    // Setup they have to delete this line to do it.
    CHECK(ClassifyClientPayload(SpringWeb::ClientPayload_ReplayControl) == WireClass::Ignored);
    CHECK_FALSE(ShouldRecordClientPayload(SpringWeb::ClientPayload_ReplayControl));
    // The last tag today. If this fails the union grew — extend the mirror.
    CHECK(SpringWeb::ClientPayload_MAX == SpringWeb::ClientPayload_ReplayControl);
    CHECK_FALSE(IsKnownClientPayload(
        static_cast<uint8_t>(SpringWeb::ClientPayload_MAX) + 1));
}

TEST_CASE("every verb the server actually applies is recorded") {
    // The three synced classes the plan names explicitly (§7 task 1:
    // "players, AI, LuaRulesMsg, joins") plus the macro verbs that were added
    // after the plan was written and are the easiest to forget.
    const SpringWeb::ClientPayload mustRecord[] = {
        SpringWeb::ClientPayload_PlayerCommand,
        SpringWeb::ClientPayload_PlayerCommandBatch,
        SpringWeb::ClientPayload_LuaRulesMsg,
        SpringWeb::ClientPayload_ConsoleCommand,
        SpringWeb::ClientPayload_StandingOrderCreate,
        SpringWeb::ClientPayload_StandingOrderUpdate,
        SpringWeb::ClientPayload_StandingOrderRemove,
        SpringWeb::ClientPayload_OrgGroupCreate,
        SpringWeb::ClientPayload_OrgGroupUpdate,
        SpringWeb::ClientPayload_OrgGroupDisband,
        SpringWeb::ClientPayload_GroupDirective,
        SpringWeb::ClientPayload_GroupDirectiveRemove,
        SpringWeb::ClientPayload_GroupPosture,
        SpringWeb::ClientPayload_AuthRequest,
        // The C1 gate an AuthRequest is inadmissible without. Dropping it made
        // every replayed human authentication bounce on "no valid handshake"
        // — the game then ran on with no human player and diverged at the
        // GameStart roster check (PLAN-replay §7.10, seen on a real recording).
        SpringWeb::ClientPayload_Handshake,
    };
    for (auto v : mustRecord) {
        INFO("verb: " << SpringWeb::EnumNameClientPayload(v));
        CHECK(ShouldRecordClientPayload(static_cast<uint8_t>(v)));
    }

    // ...and the view-only ones must NOT be, or a busy game's journal is
    // dominated by viewport spam that cannot affect the sim.
    const SpringWeb::ClientPayload mustNotRecord[] = {
        SpringWeb::ClientPayload_Ping,
        SpringWeb::ClientPayload_ViewportUpdate,
        SpringWeb::ClientPayload_SelectionState,
        SpringWeb::ClientPayload_PathRequest,
        SpringWeb::ClientPayload_PathRequestCancel,
        SpringWeb::ClientPayload_LuaUIMsg,
    };
    for (auto v : mustNotRecord) {
        INFO("verb: " << SpringWeb::EnumNameClientPayload(v));
        CHECK_FALSE(ShouldRecordClientPayload(static_cast<uint8_t>(v)));
    }
}

// ────────────────────── Funnel behaviour ──────────────────────────────

TEST_CASE("a synced input is recorded exactly once, frame- and phase-correct") {
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);

    rec.BeginTick(42);
    const uint8_t wire[] = {1, 2, 3, 4};
    CHECK(rec.RecordClientMessage(SpringWeb::ClientPayload_PlayerCommand, 7,
                                  /*clientId=*/11, wire, sizeof(wire)));

    REQUIRE(j.Records().size() == 1);
    const Record& r = j.Records()[0];
    CHECK(r.frame == 42);
    CHECK(r.phase == TickPhase::Inbound);
    CHECK(r.kind == InputKind::ClientMessage);
    CHECK(r.subKind == SpringWeb::ClientPayload_PlayerCommand);
    CHECK(r.playerId == 7);
    // The transport id survives into the record: replay re-feeds each wire
    // message under its recorded connection so the session layer it re-enters
    // tracks the same identities it did live (PLAN-replay task 2).
    CHECK(r.clientId == 11);
    CHECK(r.payload.size() == sizeof(wire));
    CHECK(r.payload[3] == 4);
    CHECK(rec.Stats().recorded == 1);
    CHECK(rec.Stats().appended == 1);
    CHECK(rec.Stats().skipped == 0);
}

TEST_CASE("unsynced verbs are counted but never stored") {
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);
    rec.BeginTick(1);

    const uint8_t wire[] = {9};
    CHECK_FALSE(rec.RecordClientMessage(SpringWeb::ClientPayload_ViewportUpdate,
                                        0, 1, wire, sizeof(wire)));
    CHECK_FALSE(rec.RecordClientMessage(SpringWeb::ClientPayload_Ping,
                                        0, 1, wire, sizeof(wire)));
    CHECK(j.Records().empty());
    CHECK(rec.Stats().seen == 2);
    CHECK(rec.Stats().skipped == 2);
    CHECK(rec.Stats().recorded == 0);
}

TEST_CASE("one record per synced-input class, each landing in its own phase") {
    // Mirrors one whole server tick: inbound → disconnect → luaexec → stream.
    // Asserts the five kinds are distinguishable and phase-tagged, which is
    // what a re-execution driver needs to re-inject them at the right point.
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);

    rec.RecordGameStart("t0:a0:l0;t1:a1:l1;");

    rec.BeginTick(100);
    const uint8_t wire[] = {1};
    rec.RecordClientMessage(SpringWeb::ClientPayload_LuaRulesMsg, 3, 5, wire, 1);

    rec.SetPhase(TickPhase::Disconnect);
    rec.RecordDisconnect(3, /*reason=*/3);

    rec.SetPhase(TickPhase::LuaExec);
    rec.RecordLuaExec(-1, "synced", "Spring.CreateUnit('x',0,0,0,0,0)");

    rec.SetPhase(TickPhase::Stream);
    const uint8_t aiBlob[] = {7, 7, 7};
    rec.RecordAICommand(2, aiBlob, sizeof(aiBlob));

    REQUIRE(j.Records().size() == 5);
    CHECK(j.Records()[0].kind == InputKind::GameStart);
    CHECK(j.Records()[1].kind == InputKind::ClientMessage);
    CHECK(j.Records()[1].phase == TickPhase::Inbound);
    CHECK(j.Records()[2].kind == InputKind::PlayerDisconnect);
    CHECK(j.Records()[2].phase == TickPhase::Disconnect);
    CHECK(j.Records()[2].subKind == 3);           // leave reason 3 = detach
    CHECK(j.Records()[3].kind == InputKind::LuaExec);
    CHECK(j.Records()[3].phase == TickPhase::LuaExec);
    CHECK(j.Records()[4].kind == InputKind::AICommand);
    CHECK(j.Records()[4].phase == TickPhase::Stream);
    CHECK(j.Records()[4].playerId == 2);

    // Every kind except SnapshotRestore exercised; counters agree.
    CHECK(rec.Stats().recorded == 5);
    CHECK(rec.Stats().byKind[(int)InputKind::ClientMessage] == 1);
    CHECK(rec.Stats().byKind[(int)InputKind::PlayerDisconnect] == 1);
    CHECK(rec.Stats().byKind[(int)InputKind::LuaExec] == 1);
    CHECK(rec.Stats().byKind[(int)InputKind::AICommand] == 1);
    CHECK(rec.Stats().byKind[(int)InputKind::GameStart] == 1);
}

TEST_CASE("the exec payload carries the scope, not just the code") {
    // A replay that re-ran exec code against the wrong Lua state would apply
    // a synced mutation unsynced (or vice versa) and diverge, so the scope is
    // part of the input.
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);
    rec.RecordLuaExec(1, "synced", "return 1");

    REQUIRE(j.Records().size() == 1);
    const auto& p = j.Records()[0].payload;
    const std::string blob(p.begin(), p.end());
    CHECK(blob.substr(0, 6) == "synced");
    CHECK(blob[6] == '\0');
    CHECK(blob.substr(7) == "return 1");
}

TEST_CASE("seq is a total order even when the frame does not advance") {
    // The paused / pre-GameStart case: sim.GetFrameNum() is constant while an
    // unbounded number of inputs arrive. Ordering by frame alone would lose
    // their sequence entirely — this is why Record carries seq.
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);

    const uint8_t wire[] = {1};
    for (int tick = 0; tick < 4; ++tick) {
        rec.BeginTick(0);                        // paused: frame never moves
        rec.RecordClientMessage(SpringWeb::ClientPayload_PlayerCommand, 1, 1, wire, 1);
    }

    REQUIRE(j.Records().size() == 4);
    std::set<uint64_t> seqs;
    for (const auto& r : j.Records()) {
        CHECK(r.frame == 0);
        seqs.insert(r.seq);
    }
    CHECK(seqs.size() == 4);
    CHECK(j.Records()[0].seq < j.Records()[3].seq);
}

TEST_CASE("a restore records the discontinuity") {
    // PLAN-replay §6 E2: a rollback starts a new segment. Without this record
    // a replay re-applies the post-rollback stream to the pre-rollback state.
    MemoryJournal j;
    Recorder rec;
    rec.SetJournal(&j);
    rec.BeginTick(900);
    rec.RecordSnapshotRestore(/*fromFrame=*/900, /*toFrame=*/600);

    REQUIRE(j.Records().size() == 1);
    CHECK(j.Records()[0].kind == InputKind::SnapshotRestore);
    REQUIRE(j.Records()[0].payload.size() == 8);
    int32_t frames[2];
    std::memcpy(frames, j.Records()[0].payload.data(), 8);
    CHECK(frames[0] == 900);
    CHECK(frames[1] == 600);
}

TEST_CASE("ring truncation is counted, never silent") {
    // E1 (journal gap): a bounded ring MUST report what it dropped, or a
    // truncated replay looks like a complete short game.
    MemoryJournal j(/*maxRecords=*/3);
    Recorder rec;
    rec.SetJournal(&j);
    rec.BeginTick(5);

    const uint8_t wire[] = {1};
    for (int i = 0; i < 5; ++i)
        rec.RecordClientMessage(SpringWeb::ClientPayload_PlayerCommand, 1, 1, wire, 1);

    CHECK(j.Records().size() == 3);
    CHECK(j.Dropped() == 2);
    // The ring keeps the NEWEST records — the tail is what a crash-window
    // investigation wants.
    CHECK(j.Records().front().seq == 3);
    CHECK(j.Records().back().seq == 5);
    CHECK(rec.Stats().appended == 5);   // appended counts offers, not survivors
}

TEST_CASE("with no journal attached the funnel still classifies and counts") {
    // The default state of every server today. An operator must be able to see
    // the cause-stream volume without paying for storage — and a run reporting
    // recorded=0 while the game clearly progressed is the signal that some
    // input path bypassed the funnel.
    Recorder rec;
    CHECK_FALSE(rec.Enabled());

    const uint8_t wire[] = {1};
    CHECK(rec.RecordClientMessage(SpringWeb::ClientPayload_PlayerCommand, 1, 1, wire, 1));
    CHECK_FALSE(rec.RecordClientMessage(SpringWeb::ClientPayload_Ping, 1, 1, wire, 1));
    CHECK(rec.Stats().recorded == 1);
    CHECK(rec.Stats().appended == 0);
    CHECK(rec.Stats().skipped == 1);

    const std::string audit = FormatAudit(rec.Stats());
    CHECK(audit.find("recorded=1") != std::string::npos);
    CHECK(audit.find("appended=0") != std::string::npos);
}

// ─────────────── T2-a: the recorded identity resolution ──────────────────

TEST_CASE("an auth identity round-trips every field it is the authority for") {
    // Each field here is one the replay cannot re-derive: userId and role come
    // from the accounts DB, and username comes from the DB too on a token
    // reconnect (the wire AuthRequest carries none). A field silently lost in
    // the codec is a replay that authorises the wrong player.
    syncedinput::AuthIdentity in;
    in.userId    = 0x0102030405060708LL;
    in.username  = "e2e_north";
    in.role      = "admin";
    in.team      = 4;
    in.playerNum = 3;
    in.spectator = false;

    const std::vector<uint8_t> blob = syncedinput::EncodeAuthIdentity(in);
    syncedinput::AuthIdentity out;
    REQUIRE(syncedinput::DecodeAuthIdentity(blob, out));
    CHECK(out.userId    == in.userId);
    CHECK(out.username  == in.username);
    CHECK(out.role      == in.role);
    CHECK(out.team      == in.team);
    CHECK(out.playerNum == in.playerNum);
    CHECK(out.spectator == in.spectator);

    // Spectators differ only in the flag and the role, and both must survive:
    // the role string is what CanCommandTeam keys off.
    syncedinput::AuthIdentity spec;
    spec.userId = 7; spec.username = "watcher"; spec.role = "spectator";
    spec.team = -1; spec.playerNum = 5; spec.spectator = true;
    syncedinput::AuthIdentity specOut;
    REQUIRE(syncedinput::DecodeAuthIdentity(
        syncedinput::EncodeAuthIdentity(spec), specOut));
    CHECK(specOut.spectator);
    CHECK(specOut.role == "spectator");
    CHECK(specOut.team == -1);
}

TEST_CASE("a short or truncated identity payload is refused, not half-decoded") {
    // A half-decoded identity is worse than none: it would hand the replay a
    // plausible username with a wrong team. Every prefix must fail.
    syncedinput::AuthIdentity in;
    in.userId = 42; in.username = "north"; in.role = "player";
    in.team = 0; in.playerNum = 1;
    const std::vector<uint8_t> blob = syncedinput::EncodeAuthIdentity(in);
    for (size_t n = 0; n < blob.size(); ++n) {
        std::vector<uint8_t> prefix(blob.begin(), blob.begin() + n);
        syncedinput::AuthIdentity out;
        CHECK_FALSE(syncedinput::DecodeAuthIdentity(prefix, out));
    }
    syncedinput::AuthIdentity ok;
    CHECK(syncedinput::DecodeAuthIdentity(blob, ok));
}

TEST_CASE("the identity resolution is recorded against its connection") {
    // It has to key on the CONNECTION, not the player number: the AuthRequest
    // that produced it was sent before the client owned a player number at all.
    Recorder rec;
    MemoryJournal j;
    rec.SetJournal(&j);
    rec.BeginTick(-1);

    syncedinput::AuthIdentity id;
    id.userId = 91; id.username = "north"; id.role = "player";
    id.team = 0; id.playerNum = 2;
    CHECK(rec.RecordAuthIdentity(77, id));

    REQUIRE(j.Records().size() == 1);
    const Record& r = j.Records().front();
    CHECK(r.kind == InputKind::AuthIdentity);
    CHECK(r.clientId == 77u);
    CHECK(r.playerId == 2);
    CHECK(r.frame == -1);        // pre-GameStart, like the AuthRequest itself
    CHECK(r.phase == TickPhase::Inbound);

    syncedinput::AuthIdentity back;
    REQUIRE(syncedinput::DecodeAuthIdentity(r.payload, back));
    CHECK(back.username == "north");
    CHECK(back.userId == 91);

    CHECK(std::string(InputKindName(InputKind::AuthIdentity)) == "auth-identity");
    CHECK(FormatAudit(rec.Stats()).find("auth-identity=1") != std::string::npos);
}
