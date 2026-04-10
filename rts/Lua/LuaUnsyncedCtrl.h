#pragma once
//
// LuaUnsyncedCtrl — the "unsynced control" API in Spring. Historically
// this housed everything a script could do that had observable side
// effects the engine didn't need to sync across P2P peers (logging,
// rendering, audio, sending messages to other players). In our
// server-authoritative model most of that category doesn't apply — the
// server has no rendering, no audio, no unsynced/synced split for
// logging, and messaging runs through the pub-sub layer.
//
// The subset we keep is the bits gadgets actually call during
// startup and runtime logic:
//
//   Spring.Echo(...)         — write args to stderr, one tab-separated line
//   Spring.Log(section, lvl, …) — structured logging with section/level
//   Spring.Error(...)        — raise a Lua error that propagates up
//
// Everything else (Spring.PlaySound, Spring.SetDrawGround, …) stays
// unimplemented until a gadget actually needs it; we'll register
// targeted stubs at that point rather than porting the full 4000-line
// original source blindly.

struct lua_State;

namespace LuaUnsyncedCtrl {
    /// Register the unsynced-ctrl functions onto the table at the top
    /// of the Lua stack (typically the `Spring` global). Returns true
    /// on success, false if the target is not a table.
    bool PushEntries(lua_State* L);
}
