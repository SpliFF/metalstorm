// LobbyIpc — see LobbyIpc.h for the design.
//
// This is the sim-side counterpart to the reader in lobby_main.cpp's
// main loop. Every helper builds a FlatBuffers IpcMessage with the
// requested payload, writes a 4-byte little-endian length prefix,
// then writes the serialised bytes. Failures on the pipe are
// treated as "channel gone" — we disable the fd and every
// subsequent Send*() becomes a silent no-op. The sim carrying on
// without an event channel is strictly better than crashing because
// a pipe briefly stalled.

#include "LobbyIpc.h"

#include "protocol_generated.h"

#include <cstdio>
#include <cstring>
#include <errno.h>
#include <unistd.h>

namespace {

/// Owned fd. -1 disables the channel and turns every Send*() into
/// a no-op. Not thread-safe; the sim main loop is the only writer.
int g_eventFd = -1;

/// Write a complete length-prefixed frame to `g_eventFd`. Handles
/// partial writes from the non-blocking/interrupted-syscall cases
/// by looping, and tears the fd down on unrecoverable errors.
void WriteFrame(const uint8_t* data, size_t len) {
    if (g_eventFd < 0 || len == 0) return;

    // 4-byte little-endian length prefix.
    uint8_t header[4];
    header[0] = static_cast<uint8_t>(len & 0xff);
    header[1] = static_cast<uint8_t>((len >> 8) & 0xff);
    header[2] = static_cast<uint8_t>((len >> 16) & 0xff);
    header[3] = static_cast<uint8_t>((len >> 24) & 0xff);

    const uint8_t* chunks[2] = { header, data };
    size_t sizes[2] = { 4, len };

    for (int i = 0; i < 2; ++i) {
        size_t off = 0;
        while (off < sizes[i]) {
            ssize_t n = write(g_eventFd, chunks[i] + off, sizes[i] - off);
            if (n > 0) { off += static_cast<size_t>(n); continue; }
            if (n < 0 && (errno == EINTR)) continue;
            // EAGAIN shouldn't happen on a blocking fd, and any
            // other error (EPIPE after the lobby closed its read
            // end, EBADF after a leak, …) means the channel is
            // dead. Disable and move on.
            std::fprintf(stderr,
                "[lobby-ipc] write failed (%s), disabling event channel\n",
                std::strerror(errno));
            close(g_eventFd);
            g_eventFd = -1;
            return;
        }
    }
}

} // namespace

namespace LobbyIpc {

void Init(int fd) {
    if (g_eventFd >= 0 && g_eventFd != fd) {
        // Shouldn't happen — Init is called once from argv parsing
        // — but if something double-initialises we'd rather close
        // the old fd than leak it.
        close(g_eventFd);
    }
    g_eventFd = fd;
    if (fd >= 0) {
        std::fprintf(stderr,
            "[lobby-ipc] event channel ready on fd %d\n", fd);
    }
}

void SendGameStarted(uint32_t frame) {
    if (g_eventFd < 0) return;

    flatbuffers::FlatBufferBuilder fbb(64);
    auto gs = SpringWeb::CreateGameStarted(fbb, frame);
    auto msg = SpringWeb::CreateIpcMessage(fbb,
        SpringWeb::IpcPayload_GameStarted, gs.Union());
    fbb.Finish(msg);

    WriteFrame(fbb.GetBufferPointer(), fbb.GetSize());
}

} // namespace LobbyIpc
