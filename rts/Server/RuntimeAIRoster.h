// RuntimeAIRoster — `room_runtime_ai`, the AI seats a war acquired WHILE it was
// running, so a resumed war comes back with a brain behind each of them.
//
// PLAN-metalstorm-ai.md §10 task 4(b), the one open thread that item left.
// Every AI in this engine used to be staged exactly once, from the `--ai`
// slots the lobby passes at launch; task 4(b) added a second staging path
// (`Spring.SpawnAIPlayer` → AISpawnRelay → ServiceAISpawns), which seats a
// caretaker on a side whose last human left. Nothing wrote that seat down.
// So a war that hibernated with a caretaker resumed with the caretaker's
// VIRTUAL PLAYER in the restored synced state — its authority pool, its org
// groups, its directives, all keyed by a playerNum — and no runtime behind it:
// a side that reads as defended and does nothing, which is the exact failure
// mode the caretaker hook exists to remove.
//
// ── Why the GAME server is both writer and reader ─────────────────────────
// Unlike `room_ai_slots` (the lobby's pre-game roster, which becomes `--ai`
// args), a runtime seat carries a value the lobby cannot mint: the sim
// **playerNum** the AI holds. That number is what every synced key about it is
// scoped by (`authority_player_<n>`, `authority_granted_<n>`, the ledger's
// spend identity), it is allocated by the game server from its own counter as
// the seat happens, and the restored snapshot brings those keys back verbatim.
// Re-seating the AI at a DIFFERENT number would strand its pool under the
// retired one — the same rule D16 already imposes on a reconnecting human.
// So the row is written by the process that allocated the number and read back
// by the process that has to honour it, and the lobby never touches it beyond
// deleting the row with the room (room ids are reused — RoomManager's
// DeleteRoomFromDb chokepoint).
//
// ── Durable, so additive migrations only ─────────────────────────────────
// Not a mirror table: while a war is frozen this is the ONLY record that the
// seat ever existed. Same rule as `war_player_bindings` / `game_events` —
// CREATE IF NOT EXISTS plus ALTER TABLE ADD COLUMN, never probe-and-drop.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct sqlite3;

/// One AI seat taken during a war. `playerNum` is the identity, not `team`: a
/// team can only hold one AI at a time (AISpawn's RefuseTeamHasAI), but the
/// number is what the restored synced state is keyed by, and it is the thing a
/// resume has to reproduce exactly.
struct RuntimeAISeat {
    uint32_t    roomId = 0;
    int         playerNum = -1;
    std::string aiId;       ///< AIDiscovery plugin id (folder name)
    int         team = -1;
    int32_t     seatedFrame = 0;  ///< sim frame it was seated on (operator log)
    int64_t     createdAt = 0;    ///< wall clock, for the same reason
};

/// What a resume decided about one stored seat. Every outcome names itself in
/// the operator log, for the reason the whole hook exists: a caretaker that
/// silently did not come back is indistinguishable from one that came back and
/// did nothing.
enum class RuntimeAIRestoreVerdict {
    /// Re-seat it: register the virtual player at the stored number and load
    /// the VM.
    Restore,
    /// The team is gone from the resumed world (a def/scenario change can
    /// retire one). Nothing to command.
    RefuseNoTeam,
    /// Empty plugin id — a row that cannot name what to load.
    RefuseNoId,
    /// The stored playerNum is already an ACTIVE player in this process. The
    /// launch roster is staged before a resume applies, so a room whose human
    /// roster grew since the freeze can legitimately have handed this number
    /// out — and double-booking it would give two players one synced identity.
    RefuseSlotTaken,
    /// Some other AI already holds this team in the resumed process (a launch
    /// `--ai` slot added to the room while it was frozen). Two brains on one
    /// authority pool is what AISpawn's RefuseTeamHasAI exists to prevent.
    RefuseTeamHasAI,
};

const char* RuntimeAIRestoreVerdictName(RuntimeAIRestoreVerdict v);

/// The policy, split out so it is testable without a sim — same shape as
/// DecideAISpawn (AISpawn.h), and deliberately NOT a method on the row: the
/// three facts it needs all come from the live process, not from the table.
RuntimeAIRestoreVerdict DecideRuntimeAIRestore(const RuntimeAISeat& seat,
                                              bool teamActive,
                                              bool playerNumTaken,
                                              bool teamHasActiveAI);

class RuntimeAIRoster {
public:
    /// Create the table if absent and migrate additively. Called from both
    /// processes: the game server writes and reads it, and the lobby deletes
    /// from it when a room dies — a lobby that has never launched a war must
    /// still find the table rather than failing that prepare forever.
    static void EnsureTable(sqlite3* db);

    /// Record a seat. `INSERT OR REPLACE` on (room_id, player_num): the seat is
    /// a fact about a number, and re-declaring the same number is either the
    /// same seat (a re-record after a resume) or a corrected one, never a
    /// second AI — the relay's per-team dedupe and RefuseTeamHasAI already make
    /// two live brains on one team impossible.
    /// Returns false only on a db/statement failure, which is logged by the
    /// caller (a lost seat is a war that resumes undefended, not chatter).
    static bool Record(sqlite3* db, const RuntimeAISeat& seat);

    /// Every stored seat for a room, ordered by playerNum — i.e. in the order
    /// the numbers were minted, which is the order the seats happened in.
    static std::vector<RuntimeAISeat> ForRoom(sqlite3* db, uint32_t roomId);

    /// Drop a room's seats. Called from RoomManager::DeleteRoomFromDb: room ids
    /// are reused, and an inherited row would seat a brain nobody added into
    /// the next war on that number.
    static int DeleteForRoom(sqlite3* db, uint32_t roomId);
};
