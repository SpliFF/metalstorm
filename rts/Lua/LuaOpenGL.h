#pragma once
// Server-build stub — no OpenGL on the server.
// LuaHandle.cpp references these to track drawing state; all are no-ops.
struct lua_State;
struct SMatrixStateData {};
struct GLMatrixStateTracker {
	SMatrixStateData PushMatrixState() { return {}; }
	void PopMatrixState(const SMatrixStateData&) {}
};
namespace LuaOpenGL {
	inline void SetDrawingEnabled(lua_State*, bool) {}
	inline bool IsDrawingEnabled(lua_State*) { return false; }
	inline bool IsDrawCallAllowed(lua_State*) { return false; }
	inline bool GetSafeMode() { return true; }
	inline void InitMatrixState(lua_State*, const char*) {}
	inline void CheckMatrixState(lua_State*, const char*, int) {}
	inline bool PushEntries(lua_State*) { return true; }
}
