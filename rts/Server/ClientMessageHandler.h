#pragma once

struct GameServerContext;
class GameStartCoordinator;
struct InboundMessage;

// ClientMessageHandler — owns the per-message dispatch switch that used to live
// inside the DrainInbound loop in server_main.cpp. Pure relocation: each case
// body is carried over verbatim, referencing the same globals directly and the
// extracted main()-locals through `ctx` / the GameStartCoordinator.
class ClientMessageHandler {
public:
    ClientMessageHandler(GameServerContext& ctx, GameStartCoordinator& start)
        : ctx(ctx), start(start) {}

    // Dispatch one drained inbound message (the body of the former
    // `for (auto& msg : messages)` loop).
    void HandleMessage(InboundMessage& msg);

private:
    GameServerContext&    ctx;
    GameStartCoordinator& start;
};
