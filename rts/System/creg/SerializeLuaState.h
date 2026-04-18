// creg stub — Lua state serialization removed with creg. No-op now.
#pragma once
#include <string>
struct lua_State;
namespace creg {
	inline void AutoRegisterCFunctions(const std::string&, lua_State*) {}
}
