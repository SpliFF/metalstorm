/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef LUA_DEFS_SERIALIZER_H
#define LUA_DEFS_SERIALIZER_H

/* LuaDefsSerializer — emit UnitDef/WeaponDef/FeatureDef/CegDef tables
 * as canonical Lua source for HTTP-served, brotli-compressed delivery
 * to the browser client. Replaces the FlatBuffer GameUnitDefs /
 * GameWeaponDefs / GameCegDefs / GameFeatureDefs payloads on the wire.
 *
 * Output shape (one file per category):
 *
 *   return {
 *     defs = {
 *       {def_id=1, name="armcom", model_url="...", health=5000, ...,
 *        custom_params={shield_radius="350", ...}},
 *       ...
 *     },
 *     base_url = "",
 *   }
 *
 * Canonical form: alphabetical key order per table, schema defaults
 * omitted, bare-identifier keys unquoted, [[...]] strings preferred,
 * numbers as %.17g for bit-exact float round-trip.
 *
 * The compressed file is served by the lobby's static handler at
 *   /api/games/data/<gameId>/cache/defs/<key>/unitdefs.lua.br
 * with `Content-Encoding: br` so the browser decompresses transparently.
 *
 * See `docs/unit_scripts.md` and the design notes in `CLAUDE.md`
 * §"Resolved Design Decisions" for the rationale.
 */

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

// Forward decls — heavy headers stay out of this one.
struct FeatureDef;
namespace CegLoader { struct CegDef; }

namespace LuaDefsSerializer {

// ─── Lua source emission ──────────────────────────────────────────

/// Quote a string as a Lua literal. Prefers `[[...]]` long-bracket form
/// (no escape processing); falls back to escaped `"..."` when the input
/// contains `]]`, a leading `[`, or characters that break long-bracket
/// parsing.
std::string LuaQuote(std::string_view s);

/// Emit a Lua-source number with full float precision (%.17g), or as
/// an integer if the value is a whole number with no fractional part.
std::string LuaNumber(double v);
std::string LuaNumber(float v);

/// Test whether a string is a valid Lua identifier (so we can emit
/// `k=v` instead of `["k"]=v`). Returns false for empty strings,
/// strings starting with a digit, or strings containing anything
/// outside `[A-Za-z0-9_]`.
bool IsLuaIdent(std::string_view s);

// ─── Brotli ───────────────────────────────────────────────────────

/// Brotli-compress `input` at the given quality (0-11; 11 = max,
/// bake-time-acceptable). Returns the compressed bytes ready to write
/// to disk as `<file>.br` and serve with `Content-Encoding: br`.
std::vector<uint8_t> CompressBrotli(std::string_view input, int quality = 11);

// ─── LuaBuilder + helpers (used by template impls in .inl) ────────

namespace detail {

/// Accumulate (key, value) pairs, sort alphabetically by key on
/// `finish()`, emit as `{k1=v1,k2=v2,...}` with bare-ident keys
/// when valid, `["key"]` form otherwise. Default-valued fields are
/// skipped — the FB serializer relied on FlatBuffers' own default
/// elision so matching that behaviour keeps wire sizes comparable.
class LuaBuilder {
public:
    void add_raw(const char* key, std::string val);          // pre-emitted
    void add_str(const char* key, std::string_view val,
                 std::string_view def = std::string_view());
    void add_float(const char* key, double val, double def = 0.0);
    void add_int(const char* key, long long val, long long def = 0);
    void add_bool(const char* key, bool val, bool def = false);
    std::string finish();
private:
    std::vector<std::pair<std::string, std::string>> pairs_;
};

/// Emit `{1,2,3}` for a vector of u16 ids. Always emits — caller
/// should skip the field when the vector is empty (LuaBuilder will
/// not, since this returns a non-default raw string).
std::string IntVector(const std::vector<uint16_t>& vec);

/// Emit `{1.5, 2.0, ...}` for a vector of floats.
std::string FloatVector(const std::vector<float>& vec);

/// Emit `{k1="v1",k2="v2"}` for a string→string map, sorted by key.
std::string StringMap(const std::vector<std::pair<std::string, std::string>>& kvs);

} // namespace detail

// ─── Concrete serializers (non-template; types are stable) ────────

/// Serialise the game's FeatureDef vector to Lua source. Model URLs
/// resolve to existing `.gltf` files under `modelsDir`; empty URL
/// when no model exists on disk.
std::string SerializeFeatureDefs(
    const std::vector<FeatureDef>& defs,
    const std::string& gameId,
    const std::filesystem::path& modelsDir);

/// Serialise CEG defs to Lua source.
std::string SerializeCegDefs(const std::vector<CegLoader::CegDef>& defs);

// ─── Template serializers (header-only; UnitDef/WeaponDef types may
//     vary between sim build and test build) ─────────────────────

template<typename UnitDefVec>
std::string SerializeUnitDefs(
    const UnitDefVec& defs,
    const std::string& gameId);

template<typename WeaponDefVec>
std::string SerializeWeaponDefs(
    const WeaponDefVec& defs,
    const std::string& gameId,
    const std::unordered_set<std::string>* projectileTextureNames = nullptr);

} // namespace LuaDefsSerializer

// Template implementations live in the .inl, included below so call
// sites only need this header.
#include "LuaDefsSerializer.inl"

#endif // LUA_DEFS_SERIALIZER_H
