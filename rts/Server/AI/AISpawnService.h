#pragma once

// ServiceAISpawns — the server-side half of the mid-game AI spawn hook
// (AISpawn.h). Lives in its own translation unit rather than in
// StateStreamer.cpp because it is the only part of the hook that needs the sim
// singletons (playerHandler, teamHandler) and therefore cannot be linked into
// spring-tests; everything decidable without them is in AISpawn.cpp and is
// covered by test_ai_spawn.cpp.

struct GameServerContext;

/// Drain every spawn request synced Lua declared since the last tick and stage
/// the accepted ones. Called once per tick from StateStreamer::TickAI, ahead
/// of the pool tick, so an AI seated this frame plans on this frame's
/// snapshot rather than waiting a tick for its first one.
void ServiceAISpawns(GameServerContext& ctx);

/// Re-seat every AI this war acquired at runtime before it was frozen
/// (RuntimeAIRoster.h). Called once, from the resume path in server_main, after
/// hibernate::DoResume has applied the world and before the `--ai` slots load
/// their runtimes — so a restored caretaker's virtual player exists at the
/// number the restored synced state is keyed by, and its brain comes up beside
/// the launch AIs rather than a tick later.
///
/// A no-op when the room has no stored seats, which is every war that never
/// emptied a side.
void RestoreRuntimeAISeats(GameServerContext& ctx);
