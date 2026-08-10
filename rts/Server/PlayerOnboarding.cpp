#include "PlayerOnboarding.h"

#include "Lua/LuaRules.h"
#include "Lua/LuaHandleSynced.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "onboarding"

namespace {

/// The synced handle, or nullptr when scripting is not up. Both entry points
/// answer false rather than crashing: a headless test scene with no LuaRules
/// must still be able to seat and drop players.
CSyncedLuaHandle* SyncedHandle() {
    if (luaRules == nullptr) return nullptr;
    if (!luaRules->syncedLuaHandle.IsValid()) return nullptr;
    return &luaRules->syncedLuaHandle;
}

}  // namespace

// Both calls go through the handle's own callin implementation rather than
// through a hand-built `lua_pcall` or an `ExecuteInLuaState` string: it is the
// same `CLuaHandle::PlayerAdded` the event list would have invoked, so the
// gadget sees exactly the callin it declared (`gadgetHandler:PlayerAdded` is
// installed as the global `PlayerAdded` by `LuaGadgets/gadgets.lua`'s
// `UpdateCallIn`, whose own `Script.UpdateCallIn` registration is the half that
// gets refused — the global is still there).
//
// Thread/ordering: both call sites run on the sim thread inside the tick
// (`msgHandler.HandleMessage` and the disconnect drain), never on the
// NetworkServer thread, so this touches synced state at a defined point.

bool FireSyncedPlayerAdded(int playerNum) {
    CSyncedLuaHandle* h = SyncedHandle();
    if (h == nullptr) {
        SLOG(SPRING_LOG_NOTICE,
            "PlayerAdded(%d) not delivered: LuaRules is not loaded", playerNum);
        return false;
    }
    h->PlayerAdded(playerNum);
    return true;
}

bool FireSyncedPlayerRemoved(int playerNum, int reason) {
    CSyncedLuaHandle* h = SyncedHandle();
    if (h == nullptr) {
        SLOG(SPRING_LOG_NOTICE,
            "PlayerRemoved(%d, %d) not delivered: LuaRules is not loaded",
            playerNum, reason);
        return false;
    }
    h->PlayerRemoved(playerNum, reason);
    return true;
}
