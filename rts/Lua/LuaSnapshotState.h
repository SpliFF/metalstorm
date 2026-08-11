/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// LuaSnapshotState — a deterministic, restorable representation of the synced
// Lua state a gadget hands to the snapshot walk (PLAN-persistence task 1d,
// contract in §7.1d).
//
// WHY A VALUE TREE AND NOT THE VM
// -------------------------------
// PLAN-persistence §2 assumed `SerializeLuaState` round-trips the whole Lua VM
// (that is what creg did upstream). In this tree that header is a seven-line
// no-op — creg is stubbed out — so the Lua half of a resume is *authored*: a
// gadget declares what of its state is durable by writing it into the table
// the `Save` call-in hands it. This type is what those tables become on the way
// to the payload.
//
// WHAT IT REFUSES, AND WHY THAT IS THE FEATURE
// --------------------------------------------
// Capture() refuses anything it could not put back identically — functions,
// userdata, threads, a table used as a *key* (a table key is its own identity,
// and identity does not survive a process restart), cycles, NaN, and nesting
// past kMaxDepth. Every refusal names the path it happened at
// ("game_objectives.pending[3].fn"), because a gadget author's first question
// is which field is the problem. A codec that silently dropped these would
// hand back a world that looks restored and is not.
//
// DETERMINISM
// -----------
// A table's pairs are stored in a canonical order (bool < number < string,
// then by value), never in `lua_next` order, which is hash order and moves
// between runs. Two snapshots of the same state must be byte-identical — the
// same reason SimSnapshot's Writer sorts unordered_sets.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct lua_State;

namespace luasnapshot {

/// Nesting limit. Deep enough for any state a gadget authors by hand, shallow
/// enough that a decoder cannot be made to recurse the C stack to death by a
/// corrupt payload (the decoder enforces the same limit on the way back in).
inline constexpr int kMaxDepth = 32;

/// A Lua value restricted to what can be reproduced in another process.
/// Deliberately not a variant: the codec needs a stable numeric discriminator
/// on the wire, and a variant's index is an artefact of the type list's order.
struct Value {
    enum class Type : uint8_t {
        Nil    = 0,
        Bool   = 1,
        Number = 2,
        String = 3,
        Table  = 4,
    };

    Type   type = Type::Nil;
    bool   b    = false;
    double num  = 0.0;   ///< double, not float: Lua numbers are doubles and a
                         ///< frame stamp past 2^24 must not be rounded.
    std::string str;
    /// Canonically ordered key/value pairs. A vector, not a map: the order IS
    /// the contract and a map would re-impose its own comparator.
    std::vector<std::pair<Value, Value>> table;

    static Value Nil()               { return {}; }
    static Value Boolean(bool v)     { Value x; x.type = Type::Bool;   x.b = v;   return x; }
    static Value Number(double v)    { Value x; x.type = Type::Number; x.num = v; return x; }
    static Value Str(std::string v)  { Value x; x.type = Type::String; x.str = std::move(v); return x; }
    static Value Table()             { Value x; x.type = Type::Table;  return x; }

    bool IsNil()   const { return type == Type::Nil; }
    bool IsTable() const { return type == Type::Table; }

    /// Lookup by string key. Returns nullptr when absent (or not a table), so
    /// a caller reading an optional field does not need to walk `table`.
    const Value* Field(const std::string& key) const;

    /// Total node count, including this one. Used by the size guards and by
    /// the boot log ("42 gadget values"), so a state that quietly grows every
    /// checkpoint is visible before it is a problem.
    size_t Nodes() const;

    bool operator==(const Value& o) const;
    bool operator!=(const Value& o) const { return !(*this == o); }
};

/// Read the value at stack index `idx` into `out`. Returns false and fills
/// `err` (with the offending path) for anything unrepresentable; `out` is then
/// unspecified. Never raises a Lua error and never leaves the stack unbalanced.
bool Capture(lua_State* L, int idx, Value& out, std::string& err);

/// Push `v` onto the stack. False + `err` only for a malformed tree (a depth
/// over kMaxDepth, or a table key that is nil/NaN — which a decoded payload can
/// contain even though Capture never produces one).
bool Push(lua_State* L, const Value& v, std::string& err);

} // namespace luasnapshot
