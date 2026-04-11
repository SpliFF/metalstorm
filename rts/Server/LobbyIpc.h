// LobbyIpc — sim-side writer for the sim → lobby event pipe.
//
// The lobby spawns spring-server with a private pipe (see
// spawnGameServer in rts/lobby_main.cpp) and passes the child's
// write end as a well-known fd number via `--event-fd <n>`.
// spring-server calls `LobbyIpc::Init(fd)` once at startup from
// its CLI parser, and anything else in the sim can later call the
// `Send*()` helpers to emit a FlatBuffers IpcMessage frame back
// to the lobby.
//
// Wire format (same shape the WebSocket side uses): a 4-byte
// little-endian length prefix followed by the raw FlatBuffers
// bytes. The lobby re-parses each frame with the generic
// `flatbuffers::GetRoot<SpringWeb::IpcMessage>`.
//
// Initialisation is optional — if the sim was launched without
// `--event-fd` (dev smoketest, direct CLI invocation), `Init` is
// never called and every `Send*()` helper is a silent no-op.
// That keeps standalone spring-server runs exactly as they were
// before this channel existed.

#pragma once

#include <cstdint>

namespace LobbyIpc {

/// Install the write-end fd provided by the lobby. Called once
/// at startup. Passing -1 (or not calling this at all) leaves
/// the channel disabled. The sim owns the fd for the lifetime
/// of the process — nothing else closes it.
void Init(int fd);

/// Send a GameStarted event. Called once from CSimulation::Init
/// right after `eventHandler.GameStart()` fires. `frame` is the
/// current sim frame number at the moment the event was emitted;
/// the lobby logs it and uses it to order concurrent events but
/// doesn't otherwise care about the value.
void SendGameStarted(uint32_t frame);

} // namespace LobbyIpc
