// EngineIdentity — the one definition of "which binary took this snapshot".
//
// PLAN-persistence task 3c. E1 (§2) refuses a snapshot whose `engineHash`
// differs from the loading binary's, and that hash has exactly one recipe:
// FNV-1a over SPRING_BUILD_STAMP (git short hash + build timestamp, see
// cmake/GenerateBuildStamp.cmake). It used to be computed inline in
// server_main's StoreConfig block, which was fine while the game server was
// the only process that cared.
//
// The drain (3c) needs a SECOND reader — the lobby, deciding before it forks
// whether a stored world can still be loaded at all — and a second hand-rolled
// copy of a hash recipe is the shape this lane keeps finding bugs in
// (`war_sides` parsed twice, the cost-table/ledger vocabularies). So the recipe
// moved here, header-only and dependency-free, and the two callers share it.
//
// WHY THE LOBBY CANNOT JUST CALL StampHash(SPRING_BUILD_STAMP)
// -----------------------------------------------------------
// It has its own stamp, and the two binaries are separate link targets: a
// `cmake --build --target spring-server` regenerates the stamp header and
// relinks the SERVER against the new value while `spring-lobby` keeps the one
// it was last built with. Worse, the lobby spawns `build/release/spring-server`
// when it exists and `build/debug/spring-server` otherwise (spawnGameServer),
// so the binary that will read the snapshot may not even be from the same
// build tree as the lobby asking about it.
//
// The honest source is therefore the binary itself: `spring-server
// --print-engine-hash` prints the 16-hex value and exits, and the lobby probes
// the very file it is about to fork (DeployDrain::ProbeServerEngineHash).
#pragma once

#include <cstdint>
#include <cstdio>
#include <string>

namespace engineid {

/// FNV-1a (64-bit) over a NUL-terminated build stamp. Pure, constexpr-able,
/// and the only place this constant pair appears.
inline uint64_t StampHash(const char* stamp) {
    uint64_t h = 1469598103934665603ull;
    if (stamp == nullptr) return h;
    for (const char* p = stamp; *p != '\0'; ++p) {
        h ^= uint64_t(static_cast<unsigned char>(*p));
        h *= 1099511628211ull;
    }
    return h;
}

/// The 16-lowercase-hex spelling `game_snapshots.engine_hash` stores. Must
/// match GameStateStore::WriteJob's `%016llx` exactly — a comparison against
/// that column is a string compare, so the width and case are load-bearing.
inline std::string HashHex(uint64_t h) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(h));
    return std::string(buf);
}

}  // namespace engineid
