/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// LuaSnapshotState — see the header for the contract (PLAN-persistence §7.1d).

#include "LuaSnapshotState.h"

#include "LuaInclude.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace luasnapshot {

const Value* Value::Field(const std::string& key) const
{
	if (type != Type::Table)
		return nullptr;

	for (const auto& kv: table) {
		if (kv.first.type == Type::String && kv.first.str == key)
			return &kv.second;
	}
	return nullptr;
}


size_t Value::Nodes() const
{
	size_t n = 1;
	for (const auto& kv: table)
		n += kv.first.Nodes() + kv.second.Nodes();
	return n;
}


bool Value::operator==(const Value& o) const
{
	if (type != o.type)
		return false;

	switch (type) {
		case Type::Nil:    return true;
		case Type::Bool:   return b == o.b;
		// Bitwise, not arithmetic: this is used by the round-trip tests to
		// assert the codec is exact, and -0.0 == 0.0 arithmetically while the
		// two are different eight-byte payloads.
		case Type::Number: {
			return std::memcmp(&num, &o.num, sizeof(num)) == 0;
		}
		case Type::String: return str == o.str;
		case Type::Table: {
			if (table.size() != o.table.size())
				return false;
			for (size_t i = 0; i < table.size(); ++i) {
				if (table[i].first != o.table[i].first) return false;
				if (table[i].second != o.table[i].second) return false;
			}
			return true;
		}
	}
	return false;
}


// ─────────────────────────── canonical order ───────────────────────────
//
// bool < number < string, then by value. `lua_next` walks a table in hash
// order, which differs between runs for the same logical content (string
// hashes are seeded, and the array/hash split moves with insertion history), so
// a capture that kept that order would make two snapshots of identical state
// differ byte-for-byte. Sorting is what makes "the same state produces the same
// bytes" true, which is what lets a test compare payloads at all.

static bool KeyLess(const Value& a, const Value& b)
{
	if (a.type != b.type)
		return static_cast<uint8_t>(a.type) < static_cast<uint8_t>(b.type);

	switch (a.type) {
		case Value::Type::Bool:   return (a.b ? 1 : 0) < (b.b ? 1 : 0);
		case Value::Type::Number: return a.num < b.num;
		case Value::Type::String: return a.str < b.str;
		default:                  return false;   // nil/table keys never reach here
	}
}


// ─────────────────────────────── capture ───────────────────────────────

namespace {

struct CaptureCtx {
	std::string err;
	/// Tables currently on the walk stack, by pointer. A cycle is a table that
	/// contains itself at any depth — not just directly — so the check has to
	/// be against the whole ancestry, not against the parent.
	std::vector<const void*> openTables;
};

/// Render a key for an error path: `.name` for identifiers, `[1]`/`["odd key"]`
/// otherwise. The path is the whole point of refusing rather than dropping.
std::string PathStep(const Value& key)
{
	switch (key.type) {
		case Value::Type::String: {
			bool ident = !key.str.empty() &&
			             !(key.str[0] >= '0' && key.str[0] <= '9');
			for (const char c: key.str) {
				if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
				      (c >= '0' && c <= '9') || c == '_'))
					ident = false;
			}
			return ident ? ("." + key.str) : ("[\"" + key.str + "\"]");
		}
		case Value::Type::Number: {
			char buf[40];
			if (key.num == std::floor(key.num) && std::abs(key.num) < 1e15)
				snprintf(buf, sizeof(buf), "[%lld]", static_cast<long long>(key.num));
			else
				snprintf(buf, sizeof(buf), "[%g]", key.num);
			return buf;
		}
		case Value::Type::Bool: return key.b ? "[true]" : "[false]";
		default:                return "[?]";
	}
}


bool CaptureAt(lua_State* L, int idx, Value& out, int depth,
               const std::string& path, CaptureCtx& ctx);

bool CaptureTable(lua_State* L, int idx, Value& out, int depth,
                  const std::string& path, CaptureCtx& ctx)
{
	if (depth >= kMaxDepth) {
		ctx.err = "nesting deeper than " + std::to_string(kMaxDepth) +
		          " at " + (path.empty() ? "<root>" : path);
		return false;
	}

	// Lua only guarantees LUA_MINSTACK (20) free slots to a C function, and
	// this walk occupies TWO of them per level for as long as the level is
	// open (the lua_next key, and the value under inspection). Without this
	// the walk runs off the end of the stack array at nesting depth 22 —
	// inside kMaxDepth, so on state a gadget is allowed to hand us — and
	// lua_next's write lands in the heap past it. That is a silent
	// out-of-bounds WRITE, not a Lua error: api_check is compiled out, so it
	// corrupts the allocator and crashes somewhere else later.
	if (!lua_checkstack(L, 4)) {
		ctx.err = "no Lua stack left to walk " +
		          (path.empty() ? std::string("<root>") : path);
		return false;
	}

	const void* self = lua_topointer(L, idx);
	for (const void* open: ctx.openTables) {
		if (open == self) {
			ctx.err = "cycle: " + (path.empty() ? std::string("<root>") : path) +
			          " refers back to a table that contains it";
			return false;
		}
	}
	ctx.openTables.push_back(self);

	out = Value::Table();
	bool ok = true;

	lua_pushnil(L);
	while (ok && lua_next(L, idx) != 0) {
		// stack: ... key value
		Value key;
		const int keyType = lua_type(L, -2);
		switch (keyType) {
			case LUA_TBOOLEAN: key = Value::Boolean(lua_toboolean(L, -2)); break;
			case LUA_TSTRING:  key = Value::Str(lua_tostring(L, -2));      break;
			case LUA_TNUMBER: {
				const double n = lua_tonumber(L, -2);
				if (std::isnan(n)) {
					// Unreachable in practice (Lua refuses a NaN key on
					// assignment) but a metatable-free rawset from C could
					// have made one, and a NaN key has no canonical order.
					ctx.err = "NaN table key at " + path;
					ok = false;
					break;
				}
				key = Value::Number(n);
			} break;
			default: {
				ctx.err = std::string("unsupported key type '") +
				          lua_typename(L, keyType) + "' at " +
				          (path.empty() ? "<root>" : path) +
				          (keyType == LUA_TTABLE
				               ? " (a table key is its own identity and cannot"
				                 " be restored in another process)"
				               : "");
				ok = false;
			} break;
		}
		if (!ok) {
			lua_pop(L, 2);
			break;
		}

		Value val;
		const int top = lua_gettop(L);
		if (!CaptureAt(L, top, val, depth + 1, path + PathStep(key), ctx)) {
			lua_pop(L, 2);
			ok = false;
			break;
		}

		// A nil value cannot come out of lua_next, but a captured nil (from a
		// future caller) would encode a pair that vanishes on restore — drop
		// it here so the tree only ever holds pairs that round-trip.
		if (!val.IsNil())
			out.table.emplace_back(std::move(key), std::move(val));

		lua_pop(L, 1);   // value; key stays for the next lua_next
	}

	ctx.openTables.pop_back();

	if (ok) {
		std::stable_sort(out.table.begin(), out.table.end(),
		                 [](const std::pair<Value, Value>& a,
		                    const std::pair<Value, Value>& b) {
			                 return KeyLess(a.first, b.first);
		                 });
	}
	return ok;
}


bool CaptureAt(lua_State* L, int idx, Value& out, int depth,
               const std::string& path, CaptureCtx& ctx)
{
	const int type = lua_type(L, idx);
	switch (type) {
		case LUA_TNIL:
		case LUA_TNONE:
			out = Value::Nil();
			return true;
		case LUA_TBOOLEAN:
			out = Value::Boolean(lua_toboolean(L, idx));
			return true;
		case LUA_TNUMBER: {
			const double n = lua_tonumber(L, idx);
			if (std::isnan(n)) {
				// A NaN in synced state is a desync in waiting; the engine
				// already refuses them elsewhere (LuaUtils::CheckTableForNaNs).
				// Refusing here means a gadget learns about it at the first
				// checkpoint rather than at the first divergence.
				ctx.err = "NaN at " + (path.empty() ? std::string("<root>") : path);
				return false;
			}
			out = Value::Number(n);
			return true;
		}
		case LUA_TSTRING: {
			size_t len = 0;
			const char* s = lua_tolstring(L, idx, &len);
			// Embedded NULs survive: Lua strings are byte strings and the wire
			// format is length-prefixed, so there is no reason to lose them.
			out = Value::Str(std::string(s, len));
			return true;
		}
		case LUA_TTABLE:
			return CaptureTable(L, idx, out, depth, path, ctx);
		default:
			ctx.err = std::string("unsupported value type '") +
			          lua_typename(L, type) + "' at " +
			          (path.empty() ? std::string("<root>") : path);
			return false;
	}
}

} // namespace


bool Capture(lua_State* L, int idx, Value& out, std::string& err)
{
	const int abs = (idx < 0 && idx > LUA_REGISTRYINDEX) ? (lua_gettop(L) + 1 + idx) : idx;
	const int top = lua_gettop(L);

	CaptureCtx ctx;
	const bool ok = CaptureAt(L, abs, out, 0, "", ctx);
	if (!ok)
		err = ctx.err;

	// The walk pushes and pops in pairs, but a refusal mid-table takes the
	// early exit — restore the stack unconditionally rather than trusting the
	// arithmetic of every failure path.
	lua_settop(L, top);
	return ok;
}


// ──────────────────────────────── push ────────────────────────────────

namespace {

bool PushAt(lua_State* L, const Value& v, int depth, std::string& err)
{
	if (depth >= kMaxDepth) {
		err = "decoded state nests deeper than " + std::to_string(kMaxDepth);
		return false;
	}

	// Same stack contract as CaptureTable, one slot worse: a table level holds
	// the table itself plus a transient key and value while it recurses.
	if (!lua_checkstack(L, 4)) {
		err = "no Lua stack left to restore decoded state";
		return false;
	}

	switch (v.type) {
		case Value::Type::Nil:    lua_pushnil(L);                       return true;
		case Value::Type::Bool:   lua_pushboolean(L, v.b ? 1 : 0);      return true;
		case Value::Type::Number: lua_pushnumber(L, v.num);             return true;
		case Value::Type::String: lua_pushlstring(L, v.str.data(), v.str.size()); return true;
		case Value::Type::Table:  break;
	}

	// One preallocated slot per pair for the array part is wrong as often as it
	// is right (string keys go to the hash part), so size both halves off the
	// key types instead of guessing.
	int narr = 0, nrec = 0;
	for (const auto& kv: v.table)
		((kv.first.type == Value::Type::Number) ? narr : nrec)++;

	lua_createtable(L, narr, nrec);

	for (const auto& kv: v.table) {
		if (kv.first.IsNil() || kv.first.IsTable()) {
			// Only reachable from a hand-built or corrupt tree; Capture cannot
			// produce either. Refuse rather than raise out of lua_rawset.
			err = "decoded state has a table with a nil or table key";
			return false;
		}
		if (kv.first.type == Value::Type::Number && std::isnan(kv.first.num)) {
			err = "decoded state has a NaN table key";
			return false;
		}
		if (!PushAt(L, kv.first, depth + 1, err))
			return false;
		if (!PushAt(L, kv.second, depth + 1, err)) {
			lua_pop(L, 1);   // the key
			return false;
		}
		lua_rawset(L, -3);
	}
	return true;
}

} // namespace


bool Push(lua_State* L, const Value& v, std::string& err)
{
	const int top = lua_gettop(L);
	if (PushAt(L, v, 0, err))
		return true;

	lua_settop(L, top);
	return false;
}

} // namespace luasnapshot
