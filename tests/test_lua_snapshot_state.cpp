// test_lua_snapshot_state — the synced-Lua half of the snapshot walk
// (PLAN-persistence task 1d, contract §7.1d).
//
// WHAT THIS COVERS AND WHY IT CAN
// -------------------------------
// The Lua side of a resume splits the same way task 1c's sim side does: a pure
// value tree in the middle. That buys real coverage on both edges without a
// server —
//
//   * Lua ↔ Value runs against a bare `luaL_newstate()`. It is the same
//     `lua_State` the engine builds its handles on (this fork's Lua is linked
//     into spring-tests), so `Capture`/`Push` are exercised on real tables,
//     real string keys and a real `lua_next` walk.
//   * Value ↔ bytes is `EncodeSyncedLua`/`DecodeSyncedLua` — the entry points a
//     restore actually calls, not a copy of them.
//
// Only the gadgetHandler dispatch (which gadget wrote which subtable, and the
// coverage ledger) needs a running game, and that is verified live.
//
// THE PROPERTY EACH GROUP DEFENDS
// -------------------------------
//   round-trip   — a gadget's state comes back identical, including the awkward
//                  numbers and byte strings a hand-rolled codec loses.
//   determinism  — the same state produces the same bytes. `lua_next` is hash
//                  order, so without the canonical sort two checkpoints of one
//                  unchanged world would differ, and every byte-level check
//                  downstream (E2's sha256 ladder included) would be noise.
//   refusal      — anything unrepresentable is named, with its path, instead of
//                  being dropped. A dropped field restores a world that looks
//                  right and is not.
//   hostility    — a corrupt payload is a decode failure, never a crash: the
//                  bytes come off disk and E1/E2 only prove the blob is ours,
//                  not that it is intact in the middle.

#include <doctest/doctest.h>

#include "Lua/LuaSnapshotState.h"
#include "Server/SimSnapshot.h"

#include "lib/lua/include/lua.h"
#include "lib/lua/include/lualib.h"
#include "lib/lua/include/lauxlib.h"

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

using luasnapshot::Value;
using simsnapshot::DecodeSyncedLua;
using simsnapshot::EncodeSyncedLua;

namespace {

/// A Lua state that closes itself. Nothing here needs the engine's handle
/// machinery — Capture/Push only use the plain C API.
struct LuaFixture {
    lua_State* L = nullptr;
    LuaFixture() : L(luaL_newstate()) {
        REQUIRE(L != nullptr);
        // The standard libraries, because two of the refusal cases need a value
        // type only the libraries can produce (a coroutine) or a C function to
        // stand in for a gadget's closure.
        luaL_openlibs(L);
    }
    ~LuaFixture() { if (L != nullptr) lua_close(L); }

    /// Run `code` and leave its single return value on the stack.
    void Eval(const char* code) {
        const std::string chunk = std::string("return ") + code;
        REQUIRE(luaL_loadbuffer(L, chunk.c_str(), chunk.size(), "test") == 0);
        REQUIRE(lua_pcall(L, 0, 1, 0) == 0);
    }
};

/// Capture the value at the top of the stack, requiring success.
Value CaptureTop(lua_State* L) {
    Value v;
    std::string err;
    const bool ok = luasnapshot::Capture(L, -1, v, err);
    INFO("capture error: " << err);
    REQUIRE(ok);
    return v;
}

std::vector<uint8_t> Bytes(const Value& v) {
    std::vector<uint8_t> out;
    EncodeSyncedLua(v, out);
    return out;
}

Value Decoded(const std::vector<uint8_t>& bytes) {
    Value v;
    std::string err;
    const bool ok = DecodeSyncedLua(bytes.data(), bytes.size(), v, err);
    INFO("decode error: " << err);
    REQUIRE(ok);
    return v;
}

} // namespace

// ─────────────────────────── the value tree ───────────────────────────

TEST_CASE("task 1d: the census is armed") {
    // Same tripwire as 1c's structs: a seventh member of luasnapshot::Value
    // fails the build in SimSnapshot.cpp until the codec writes it. Six as of
    // Q-P6 (the `i` integer payload).
    Value v;
    CHECK(simsnapshot::census::LuaValue(v) == 6);
}

TEST_CASE("task 1d: Field and Nodes read the tree without walking it by hand") {
    Value t = Value::Table();
    t.table.emplace_back(Value::Str("a"), Value::Number(1.0));
    t.table.emplace_back(Value::Str("b"), Value::Table());

    REQUIRE(t.Field("a") != nullptr);
    CHECK(t.Field("a")->num == 1.0);
    CHECK(t.Field("missing") == nullptr);
    // A non-table has no fields, and asking must not be a special case at the
    // call site (SyncedLua's resolve does exactly this on a corrupt payload).
    CHECK(Value::Number(3.0).Field("a") == nullptr);

    // root + 2 keys + a number + an empty table
    CHECK(t.Nodes() == 5);
}

// ────────────────────────── Lua ↔ Value ↔ bytes ──────────────────────────

TEST_CASE("task 1d: a gadget's state round-trips through Lua, the tree and the bytes") {
    LuaFixture lua;
    // Shaped like real gadget state: string keys at the top, an array of
    // records, mixed value types, a nested table, and an empty table (which a
    // gadget uses for "nothing pending yet").
    lua.Eval(R"({
        version = 3,
        active = true,
        muted = false,
        label = 'Meridian Basin',
        pending = { 11, 22, 33 },
        byUnit = { [1041] = { hits = 2, last = 'shell' }, [7] = { hits = 0 } },
        empty = {},
        deep = { a = { b = { c = 'leaf' } } },
    })");

    const Value captured = CaptureTop(lua.L);
    const Value decoded  = Decoded(Bytes(captured));
    CHECK(decoded == captured);

    // ...and back into Lua, then captured again: this is the full loop a
    // restore runs, so an asymmetry in Push shows up here rather than live.
    std::string err;
    REQUIRE(luasnapshot::Push(lua.L, decoded, err));
    const Value reCaptured = CaptureTop(lua.L);
    CHECK(reCaptured == captured);

    // Spot-check through Lua itself, not just through the tree: a codec that
    // agreed with itself about a wrong shape would pass the checks above.
    lua_getfield(lua.L, -1, "label");
    CHECK(std::string(lua_tostring(lua.L, -1)) == "Meridian Basin");
    lua_pop(lua.L, 1);
    lua_getfield(lua.L, -1, "byUnit");
    lua_pushnumber(lua.L, 1041);
    lua_rawget(lua.L, -2);
    lua_getfield(lua.L, -1, "hits");
    CHECK(lua_tonumber(lua.L, -1) == 2);
    lua_pop(lua.L, 3);
}

TEST_CASE("task 1d: the awkward numbers survive") {
    LuaFixture lua;
    // Doubles, not floats. 2^53-1 is the frame stamp / accumulated-resource
    // case: an F32 payload (which the rest of the walk uses for sim floats)
    // rounds it, and the failure looks like a gadget losing count slowly.
    lua.Eval("{ 9007199254740991, -0.0, 1/0, -1/0, 0.1, 1e-320, -2147483648 }");

    const Value captured = CaptureTop(lua.L);
    const Value decoded  = Decoded(Bytes(captured));
    CHECK(decoded == captured);

    REQUIRE(captured.table.size() == 7);
    // 2^53-1 is written `9007199254740991` in Lua 5.4, which is an *integer*
    // literal, so it rides the Q-P6 subtype and is exact rather than merely
    // unrounded.
    CHECK(captured.table[0].second.type == Value::Type::Integer);
    CHECK(captured.table[0].second.i == 9007199254740991LL);
    CHECK(captured.table[6].second.type == Value::Type::Integer);
    CHECK(captured.table[6].second.i == -2147483648LL);
    // -0.0: compared bitwise by Value::operator==, so this asserts the sign
    // bit made the trip (checked to fail with a memcmp-free comparison).
    CHECK(std::signbit(decoded.table[1].second.num));
    CHECK(std::isinf(decoded.table[2].second.num));
    CHECK(decoded.table[3].second.num < 0);
    CHECK(std::isinf(decoded.table[3].second.num));
    CHECK(decoded.table[4].second.num == doctest::Approx(0.1));
    // A denormal is still a number the encoder must not normalise away.
    CHECK(decoded.table[5].second.num > 0.0);
}

TEST_CASE("Q-P6: a restored counter is still an integer, so a key built from it is spelled the same") {
    // The live defect this closes: a gadget's `seq` came back from a resume as a
    // float, and `'warlog_' .. seq .. '_kind'` then published `warlog_1.0_kind`
    // — a rules param key the war-digest drain and every objective lookup do not
    // read. Nothing about the *value* was wrong (the strict round-trip held all
    // 30 hashes and all 26 units), so the assertion has to be on the subtype and
    // on the string a gadget builds from it, not on equality.
    LuaFixture lua;
    lua.Eval("{ seq = 1, count = 41 + 1, deliberateFloat = 3.0, ratio = 0.5, "
             "big = 9007199254740993 }");

    const Value captured = CaptureTop(lua.L);
    const Value decoded  = Decoded(Bytes(captured));
    REQUIRE(decoded == captured);

    // A deliberate float with an integral value stays a float — this is what
    // option B3 (push integral doubles as integers) would have got wrong, and
    // the reason the wire subtype was worth a codec bump.
    REQUIRE(decoded.Field("deliberateFloat") != nullptr);
    CHECK(decoded.Field("deliberateFloat")->type == Value::Type::Number);
    REQUIRE(decoded.Field("ratio") != nullptr);
    CHECK(decoded.Field("ratio")->type == Value::Type::Number);
    // 2^53+1 is not representable as a double, so the integer path is the only
    // one that can carry it back unchanged.
    REQUIRE(decoded.Field("big") != nullptr);
    CHECK(decoded.Field("big")->i == 9007199254740993LL);

    std::string err;
    REQUIRE(luasnapshot::Push(lua.L, decoded, err));

    // The gadget's own idiom, run against the restored table.
    lua_pushstring(lua.L, "warlog_");
    lua_getfield(lua.L, -2, "seq");
    lua_pushstring(lua.L, "_kind");
    lua_concat(lua.L, 3);
    CHECK(std::string(lua_tostring(lua.L, -1)) == "warlog_1_kind");
    lua_pop(lua.L, 1);

    const auto mathType = [&](const char* field) {
        lua_getglobal(lua.L, "math");
        lua_getfield(lua.L, -1, "type");
        lua_getfield(lua.L, -3, field);
        REQUIRE(lua_pcall(lua.L, 1, 1, 0) == 0);
        const std::string t = lua_tostring(lua.L, -1) ? lua_tostring(lua.L, -1) : "nil";
        lua_pop(lua.L, 2);   // result + math
        return t;
    };
    CHECK(mathType("seq") == "integer");
    CHECK(mathType("count") == "integer");
    CHECK(mathType("deliberateFloat") == "float");
    CHECK(mathType("ratio") == "float");
    lua_pop(lua.L, 2);   // the restored table + the captured source
}

TEST_CASE("task 1d: a string is bytes, not a C string") {
    LuaFixture lua;
    lua.Eval("{ nul = 'a\\0b', utf8 = 'Ω≈ç', empty = '' }");

    const Value captured = CaptureTop(lua.L);
    REQUIRE(captured.Field("nul") != nullptr);
    CHECK(captured.Field("nul")->str.size() == 3);   // the NUL is not a terminator
    CHECK(Decoded(Bytes(captured)) == captured);

    std::string err;
    REQUIRE(luasnapshot::Push(lua.L, captured, err));
    lua_getfield(lua.L, -1, "nul");
    size_t len = 0;
    lua_tolstring(lua.L, -1, &len);
    CHECK(len == 3);
    lua_pop(lua.L, 2);
}

TEST_CASE("task 1d: boolean and numeric keys are keys too") {
    LuaFixture lua;
    lua.Eval("{ [true] = 'yes', [false] = 'no', [1.5] = 'half', [2] = 'two' }");

    const Value captured = CaptureTop(lua.L);
    const Value decoded  = Decoded(Bytes(captured));
    CHECK(decoded == captured);

    // Canonical order puts booleans before numbers, and false before true. The
    // two number subtypes share one sort class and interleave by value, so the
    // float 1.5 still sorts before the integer 2 (Q-P6: ordering must not
    // depend on which subtype a gadget happened to write).
    REQUIRE(captured.table.size() == 4);
    CHECK(captured.table[0].first.type == Value::Type::Bool);
    CHECK(captured.table[0].first.b == false);
    CHECK(captured.table[1].first.b == true);
    CHECK(captured.table[2].first.type == Value::Type::Number);
    CHECK(captured.table[2].first.num == 1.5);
    CHECK(captured.table[3].first.type == Value::Type::Integer);
    CHECK(captured.table[3].first.i == 2);
}

// ───────────────────────────── determinism ─────────────────────────────

TEST_CASE("task 1d: the same state produces the same bytes, whatever the insertion order") {
    LuaFixture lua;
    // Same content, opposite insertion order, and enough string keys that
    // lua_next's hash order differs between the two tables. Without the
    // canonical sort in Capture these two encode differently (checked to fail
    // by returning early from the stable_sort).
    lua.Eval("{ alpha = 1, beta = 2, gamma = 3, delta = 4, epsilon = 5, zeta = 6 }");
    const std::vector<uint8_t> a = Bytes(CaptureTop(lua.L));
    lua_pop(lua.L, 1);

    lua.Eval("(function() local t = {} "
             "t.zeta = 6 t.epsilon = 5 t.delta = 4 t.gamma = 3 t.beta = 2 t.alpha = 1 "
             "return t end)()");
    const std::vector<uint8_t> b = Bytes(CaptureTop(lua.L));

    CHECK(a == b);
}

TEST_CASE("task 1d: the decoder preserves order rather than re-imposing it") {
    // A payload written out of canonical order decodes out of order — the
    // decoder must not paper over a writer that stopped sorting, or the
    // determinism test above could pass with the sort deleted.
    Value t = Value::Table();
    t.table.emplace_back(Value::Str("zzz"), Value::Number(1.0));
    t.table.emplace_back(Value::Str("aaa"), Value::Number(2.0));

    const Value decoded = Decoded(Bytes(t));
    REQUIRE(decoded.table.size() == 2);
    CHECK(decoded.table[0].first.str == "zzz");
}

// ────────────────────────────── refusals ──────────────────────────────

TEST_CASE("task 1d: what cannot be restored is refused, by path") {
    LuaFixture lua;

    SUBCASE("a function") {
        lua.Eval("{ state = { tick = function() end } }");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        INFO("err: " << err);
        CHECK(err.find("function") != std::string::npos);
        // The path is the point: a gadget author's first question is which
        // field, and there is no other way to find it in a 200-key table.
        CHECK(err.find(".state.tick") != std::string::npos);
    }
    SUBCASE("a table used as a key") {
        lua.Eval("(function() local t = {} t[{}] = 1 return t end)()");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        INFO("err: " << err);
        CHECK(err.find("identity") != std::string::npos);
    }
    SUBCASE("a cycle") {
        lua.Eval("(function() local t = { name = 'a' } t.self = t return t end)()");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        INFO("err: " << err);
        CHECK(err.find("cycle") != std::string::npos);
    }
    SUBCASE("a cycle through a grandchild, not just a self-reference") {
        // The check has to be against the whole ancestry; a parent-only check
        // passes this one and then recurses until the stack dies.
        lua.Eval("(function() local a = {} local b = {} local c = {} "
                 "a.b = b b.c = c c.a = a return a end)()");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        CHECK(err.find("cycle") != std::string::npos);
    }
    SUBCASE("a NaN") {
        lua.Eval("{ ratio = 0/0 }");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        INFO("err: " << err);
        CHECK(err.find("NaN") != std::string::npos);
        CHECK(err.find(".ratio") != std::string::npos);
    }
    SUBCASE("nesting past the depth limit") {
        lua.Eval("(function() local root = {} local t = root "
                 "for i = 1, 40 do t.child = {} t = t.child end return root end)()");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        INFO("err: " << err);
        CHECK(err.find("nesting") != std::string::npos);
    }
    SUBCASE("a coroutine") {
        lua.Eval("{ job = coroutine.create(function() end) }");
        Value v;
        std::string err;
        CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
        CHECK(err.find(".job") != std::string::npos);
    }
}

TEST_CASE("task 1d: a refusal leaves the Lua stack exactly as it was") {
    // Capture is called from a call-in with the state table on the stack; a
    // refusal that leaked two slots per failed table would corrupt the handle
    // (and the ScopedStackChecker in a DEBUG_LUA build would abort the server).
    LuaFixture lua;
    lua.Eval("{ a = { b = { c = print } } }");
    const int top = lua_gettop(lua.L);

    Value v;
    std::string err;
    CHECK_FALSE(luasnapshot::Capture(lua.L, -1, v, err));
    CHECK(lua_gettop(lua.L) == top);
}

TEST_CASE("task 1d: legal nesting deeper than LUA_MINSTACK is walked, not written past") {
    // D64(a). The walk holds TWO Lua stack slots per open level (the lua_next
    // key and the value under inspection) but Lua only guarantees LUA_MINSTACK
    // = 20 free slots to a C function. Without lua_checkstack the walk ran off
    // the end of the stack array at nesting depth 22 — well inside kMaxDepth,
    // so on state a gadget is entitled to hand us — and lua_next's write landed
    // in the heap past it. api_check is compiled out, so nothing raised: it was
    // a silent out-of-bounds write that corrupted the allocator and killed the
    // process somewhere else, later, at about 1 run in 3.
    //
    // ⚠️ THIS CASE CANNOT FAIL WITHOUT A SANITIZER — pre-fix it passes, because
    // the overflow is silent and the captured tree is still correct. It pins
    // the reachable contract (a legal depth is accepted; an illegal one is
    // refused by path, not by crashing). The instrument that DOES fail pre-fix
    // is AddressSanitizer, and it is deterministic there; reproduce with:
    //
    //   clang++ -std=c++20 -g -O0 -fsanitize=address -I rts -I rts/lib/lua/include \
    //     <driver>.cpp rts/Lua/LuaSnapshotState.cpp rts/lib/lua/src/*.cpp -o /tmp/d64
    //
    // ...capturing a table nested 22+ deep. Baseline: heap-buffer-overflow,
    // 8-byte WRITE in luaH_next (ltable.cpp:363) via LuaSnapshotState.cpp:157.
    const int legal = luasnapshot::kMaxDepth - 1;   // 31: deepest accepted level

    LuaFixture lua;
    const std::string src =
        "(function() local root = {} local t = root "
        "for i = 1, " + std::to_string(legal - 1) + " do t.child = {} t = t.child end "
        "t.leaf = 'end' return root end)()";
    lua.Eval(src.c_str());

    const int top = lua_gettop(lua.L);
    Value v;
    std::string err;
    REQUIRE(luasnapshot::Capture(lua.L, -1, v, err));
    CHECK(lua_gettop(lua.L) == top);
    CHECK(Decoded(Bytes(v)) == v);

    // The tree really is that deep — otherwise this passes by capturing nothing.
    int measured = 0;
    for (const Value* n = &v; n->type == Value::Type::Table && !n->table.empty(); ) {
        ++measured;
        const Value& child = n->table[0].second;
        if (child.type != Value::Type::Table) break;
        n = &child;
    }
    CHECK(measured == legal);

    // Push has the same contract, one slot worse (table + key + value per level).
    REQUIRE(luasnapshot::Push(lua.L, v, err));
    lua_pop(lua.L, 1);
    CHECK(lua_gettop(lua.L) == top);
}

TEST_CASE("task 1d: a nil value is not a pair") {
    // Lua cannot store a nil value, so a nil in the tree would encode a pair
    // that vanishes on restore — the two sides would disagree about the pair
    // count while both being "correct".
    LuaFixture lua;
    lua.Eval("{ a = 1, b = nil, c = 3 }");
    const Value captured = CaptureTop(lua.L);
    CHECK(captured.table.size() == 2);
}

// ────────────────────── a hostile payload (decode) ──────────────────────

TEST_CASE("task 1d: every truncation of a real payload is refused") {
    LuaFixture lua;
    lua.Eval("{ version = 2, names = { 'alpha', 'beta' }, "
             "flags = { on = true, off = false }, count = 17.5 }");
    const std::vector<uint8_t> full = Bytes(CaptureTop(lua.L));
    REQUIRE(full.size() > 40);

    // EVERY cut point, not every seventh: task 1c's Finding 3 was two interior
    // offsets out of ~250 that a sampling sweep missed.
    for (size_t cut = 0; cut < full.size(); ++cut) {
        INFO("cut at " << cut << " of " << full.size());
        Value v;
        std::string err;
        CHECK_FALSE(DecodeSyncedLua(full.data(), cut, v, err));
        CHECK(!err.empty());
    }

    // ...and the whole payload is accepted, so the sweep is not passing because
    // the decoder refuses everything.
    Value v;
    std::string err;
    CHECK(DecodeSyncedLua(full.data(), full.size(), v, err));
}

TEST_CASE("task 1d: garbage in the type byte is a refusal, not an interpretation") {
    const std::vector<uint8_t> bad = {99};
    Value v;
    std::string err;
    CHECK_FALSE(DecodeSyncedLua(bad.data(), bad.size(), v, err));
}

TEST_CASE("task 1d: an absurd pair count is refused") {
    // Table type byte + a count of ~4 billion pairs in five bytes. Stated
    // precisely, because a neutralisation run measured it: the REFUSAL here is
    // the reader's ordinary bounds check, which fails on the first missing pair
    // - disabling the "this count cannot fit" guard does not make this test
    // pass a corrupt payload. That guard is about the reserve() in between: it
    // keeps a bad count from being a 400 GB allocation on the way to the same
    // answer, which no assertion here can observe.
    std::vector<uint8_t> bad = {uint8_t(Value::Type::Table), 0xFF, 0xFF, 0xFF, 0xFF};
    Value v;
    std::string err;
    CHECK_FALSE(DecodeSyncedLua(bad.data(), bad.size(), v, err));
}

TEST_CASE("task 1d: a depth bomb in the payload is refused, not recursed") {
    // 4096 nested one-pair tables: each is 1 type byte + 4 count bytes + a key,
    // so the payload is small and the recursion is not. The decoder's own depth
    // limit is what stops it (checked to fail: with the reader's depth guard
    // disabled this payload decodes as SUCCESS, i.e. a corrupt blob becomes a
    // 4096-deep tree the Load call-in then tries to push into Lua).
    std::vector<uint8_t> bomb;
    for (int i = 0; i < 4096; ++i) {
        bomb.push_back(uint8_t(Value::Type::Table));
        bomb.push_back(1); bomb.push_back(0); bomb.push_back(0); bomb.push_back(0);
        bomb.push_back(uint8_t(Value::Type::Bool));   // key
        bomb.push_back(1);
    }
    bomb.push_back(uint8_t(Value::Type::Nil));

    Value v;
    std::string err;
    CHECK_FALSE(DecodeSyncedLua(bomb.data(), bomb.size(), v, err));
}

TEST_CASE("task 1d: trailing bytes after the value are refused") {
    LuaFixture lua;
    lua.Eval("{ a = 1 }");
    std::vector<uint8_t> bytes = Bytes(CaptureTop(lua.L));
    bytes.push_back(0);

    Value v;
    std::string err;
    CHECK_FALSE(DecodeSyncedLua(bytes.data(), bytes.size(), v, err));
    CHECK(err.find("trailing") != std::string::npos);
}

TEST_CASE("task 1d: an empty state is legal and stays empty") {
    // A game whose gadgets are all stateless produces this. It must not be
    // confused with a failure — the coverage ledger, not the payload size, is
    // what says whether an empty capture is acceptable.
    const Value empty = Value::Table();
    const Value decoded = Decoded(Bytes(empty));
    CHECK(decoded == empty);
    CHECK(decoded.IsTable());
    CHECK(decoded.table.empty());
}

TEST_CASE("task 1d: a decoded payload with a nil table key is refused by Push") {
    // Unreachable from Capture, reachable from a corrupt payload: the key type
    // byte is one byte, and a flipped bit turns a string key into nil. Pushing
    // it would raise a Lua error out of lua_rawset inside the Load call-in.
    LuaFixture lua;
    Value t = Value::Table();
    t.table.emplace_back(Value::Nil(), Value::Number(1.0));

    std::string err;
    const int top = lua_gettop(lua.L);
    CHECK_FALSE(luasnapshot::Push(lua.L, t, err));
    CHECK(lua_gettop(lua.L) == top);
    CHECK(err.find("nil or table key") != std::string::npos);
}

// ─────────────── the staging check (no synced state in a doctest) ───────────────
//
// A doctest process has no luaRules and no luaGaia, which is exactly the shape
// that makes these checks meaningful: "the payload carries state for a handle
// this run has not loaded" is the mismatch that would otherwise be a silent
// drop, and here every handle is absent.

TEST_CASE("task 1d: staging accepts a payload that matches the live handles") {
    std::string err;
    CHECK(simsnapshot::ResolveSyncedLua(Value::Table(), err));
    CHECK(err.empty());
}

TEST_CASE("task 1d: staging refuses state for a handle this run does not have") {
    // The live case behind it: a snapshot taken on a map that ships LuaGaia,
    // restored on one that does not. Refusing during staging is the difference
    // between a rolled-back restore and a world missing a whole handle's gadgets.
    Value payload = Value::Table();
    payload.table.emplace_back(Value::Str("rules"), Value::Table());

    std::string err;
    CHECK_FALSE(simsnapshot::ResolveSyncedLua(payload, err));
    INFO("err: " << err);
    CHECK(err.find("rules") != std::string::npos);
}

TEST_CASE("task 1d: staging refuses a syncedLua section that is not a table") {
    // Reachable from a payload whose section bytes decoded cleanly as a number:
    // the type byte is one byte, and E1/E2 prove the blob is ours, not that
    // every byte inside it is the one that was written.
    std::string err;
    CHECK_FALSE(simsnapshot::ResolveSyncedLua(Value::Number(3.0), err));
    CHECK(err.find("not a table") != std::string::npos);
}

TEST_CASE("task 1d: staging refuses a non-string handle key") {
    Value payload = Value::Table();
    payload.table.emplace_back(Value::Number(1.0), Value::Table());

    std::string err;
    CHECK_FALSE(simsnapshot::ResolveSyncedLua(payload, err));
    CHECK(err.find("non-string") != std::string::npos);
}
