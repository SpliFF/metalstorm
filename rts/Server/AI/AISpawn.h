#pragma once

// AISpawn — mid-game AI instantiation (PLAN-metalstorm-ai.md §10 task 4(b),
// the `ai_caretaker` hook).
//
// Every AI in this engine used to be staged exactly once, in server_main's
// set-up block, from the `--ai id:team` slots the lobby passed on the command
// line. That is the whole reason `GG.AI.ActivateCaretaker` shipped as a
// documented no-op: when the last human on a side leaves, an AI that is
// ALREADY on that team upgrades itself in place (game_teams.lua's
// refreshCoCommanders), but a side that never had one had nothing to upgrade
// and no way to acquire one.
//
// This file is the missing half, and it is deliberately a RELAY rather than a
// direct call, for the same reason GameOverState.h is one: the decision is made
// in synced Lua (which knows the social rule — "the whole side has emptied")
// and the act needs the server's own objects (AIDiscovery, AIRuntimePool,
// playerHandler), which synced Lua cannot and should not reach. Synced Lua
// declares here through `Spring.SpawnAIPlayer`; the server drains once per
// tick, at a fixed point in StateStreamer::Tick.
//
// DETERMINISM / REPLAY. A spawn is NOT a new journal input and is deliberately
// not recorded: it is *derived* from synced state (the leaver whose departure
// triggered it is already journalled — `RecordDisconnect` → PlayerRemoved), so
// re-executing the same synced Lua re-declares it at the same frame. What the
// replay must NOT do is run a second copy of the AI's brain — the AI's output
// is an input to the sim (PLAN-replay §7.1) and is fed from the recording —
// so the drain registers the virtual player (synced) and skips the VM
// (unsynced). See ServiceAISpawns.
//
// FIDELITY-STANDIN: stock Spring/Recoil has no synced call that creates a
// SkirmishAI — AI slots are fixed by the game setup script. This is a fork
// addition, allowed under the client-server carve-out in the code-session
// contract (this engine is server-authoritative and owns the roster outright),
// and confined to the two sites below plus `Spring.SpawnAIPlayer`.

#include <string>
#include <vector>

/// One requested mid-game AI, as declared by synced Lua.
struct AISpawnRequest {
    /// Team the AI takes over. Validated by the Lua binding before it lands
    /// here, and re-checked at drain time (a team can die in between).
    int teamId = -1;
    /// AIDiscovery plugin id — the folder name, e.g. "strategos".
    std::string aiId;
};

// NOTE — no `profile` field, deliberately. A start-up slot carries one because
// its only transport is the command line (`--ai id:team:pos:profile` →
// modoption → game_teams republishes it as a team rulesParam at GameStart). A
// runtime spawn is declared FROM synced Lua, which can simply write the
// rulesParam the AI VM reads (`ai_profile` / `ai_profile_<playerID>`,
// picture.lua readProfileHint) before it declares — so routing the string
// through the engine and back would be a second transport for a value that
// never left the synced state. game_ai_caretaker.lua does exactly that.

/// What the server decided about one requested spawn. Every outcome names
/// itself in the operator log — a caretaker that silently did not arrive is
/// indistinguishable from one that arrived and did nothing, which is the whole
/// failure mode this hook exists to remove.
enum class AISpawnVerdict {
    /// Stage it: resolve the plugin, register the virtual player, load the VM.
    Spawn,
    /// No such team (or the team index is out of range).
    RefuseNoTeam,
    /// Empty plugin id — nothing to resolve.
    RefuseNoId,
    /// The team already has an active AI player. That AI upgrades itself in
    /// place when the humans leave (game_teams.lua §5.1), so a second brain
    /// would fight the first for the same pool and the same groups.
    RefuseTeamHasAI,
    /// The game has not started. Pre-GameStart the `--ai` slots own the roster
    /// and their virtual players are registered as a block; injecting one here
    /// would race that block and change which player leads the team.
    RefuseNotStarted,
};

const char* AISpawnVerdictName(AISpawnVerdict v);

/// The policy, split out so it is testable without a sim (same shape as
/// DecideOnboardingHook in PlayerOnboarding.h).
AISpawnVerdict DecideAISpawn(int teamId, const std::string& aiId,
                             bool teamHasActiveAI, bool gameStarted);

/// Sim-thread relay: written by `Spring.SpawnAIPlayer` (synced Lua), drained
/// by ServiceAISpawns. Single-threaded by construction — both ends run on the
/// sim thread, like GameOverRelay and unlike PlayerTeamEventCollector.
class AISpawnRelay {
public:
    /// Queue a request. Returns false if this team already has one pending —
    /// the caretaker hook can fire more than once for one emptying side (every
    /// PlayerRemoved on that team re-tests it), and two queued requests would
    /// seat two brains before either is visible to the has-an-AI check.
    bool Request(const AISpawnRequest& rq);

    /// Take everything queued and clear. Ordered by declaration, which is the
    /// order synced Lua declared in — the same order a replay re-declares in.
    std::vector<AISpawnRequest> Drain();

    size_t PendingCount() const { return pending.size(); }
    void Clear() { pending.clear(); }

private:
    std::vector<AISpawnRequest> pending;
};

extern AISpawnRelay aiSpawnRelay;

/// The roots a runtime spawn resolves its plugin and file-read sandbox
/// against. Populated once in server_main from the same values the start-up
/// AI staging block uses, so an AI seated at frame 40 000 is loaded from the
/// identical paths as one seated at frame 0.
struct AISpawnEnv {
    std::string enginePath;    ///< "content/engine"
    std::string gamePath;      ///< data/games/<gameId>
    std::string mapDataDir;    ///< AI4 map-data root (data/maps/<id>), may be ""
    std::string defExportDir;  ///< AI4 def-export root (defs cache), may be ""
};

/// A plugin resolved off disk, with its entry buffer already slurped.
struct ResolvedAIPlugin {
    std::string id;
    std::string displayName;
    std::string folderPath;   ///< plugin-scoped `require` root (AI0-loader)
    std::string code;         ///< contents of the entry script
    /// Classic Spring "LuaAI" registry entry: no standalone runtime, the logic
    /// lives in the game's synced gadgets. Has no code and must not be loaded.
    bool isLuaAI = false;
};

/// Resolve `id` against the engine + game AI roots and read its entry script.
/// Returns false with `err` set on an unknown id or an unreadable entry; a
/// LuaAI resolves successfully with `isLuaAI` true and an empty `code`.
///
/// Shared by the start-up staging block and the runtime spawn precisely so the
/// two cannot drift: an AI the lobby can seat at frame 0 is an AI the caretaker
/// hook can seat at frame N, resolved by the same rules (game shadows engine).
bool ResolveAIPlugin(const std::string& enginePath, const std::string& gamePath,
                     const std::string& id, ResolvedAIPlugin& out,
                     std::string& err);
