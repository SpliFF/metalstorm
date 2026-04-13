// SpringLogNet — optional network sink (WebSocket + FlatBuffers).
// Connects to a log server and pushes log entries via LogIngest messages.
// Links: springlog + uws + flatbuffers.

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

// Connect to a log server's WebSocket and authenticate. Registers itself
// as a custom sink via springlog_add_sink(). Returns 0 on success.
int springlog_net_init(const char* url, const char* token);

// Disconnect and deregister. Called before springlog_shutdown().
void springlog_net_shutdown(void);

#ifdef __cplusplus
}
#endif
