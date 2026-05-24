/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "LuaDefsSerializer.h"
#include "Sim/Features/FeatureDef.h"
#include "Server/CegLoader.h"

#include <brotli/encode.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <unordered_set>

namespace LuaDefsSerializer {

// ─── Lua-source emission primitives ───────────────────────────────

static const std::unordered_set<std::string_view> kLuaReserved = {
    "and", "break", "do", "else", "elseif", "end", "false", "for",
    "function", "goto", "if", "in", "local", "nil", "not", "or",
    "repeat", "return", "then", "true", "until", "while",
};

bool IsLuaIdent(std::string_view s)
{
    if (s.empty()) return false;
    if (!std::isalpha(static_cast<unsigned char>(s[0])) && s[0] != '_')
        return false;
    for (char c : s) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '_')
            return false;
    }
    return kLuaReserved.find(s) == kLuaReserved.end();
}

std::string LuaQuote(std::string_view s)
{
    // Prefer `[[...]]` long-bracket form: no escape processing, fast
    // to parse, debuggable. Skip when the content would break that
    // form (`]]` inside, leading `[` triggers stripping ambiguity,
    // or embedded newline — Lua strips a leading newline after `[[`,
    // and we don't want that surprise).
    bool useLong = true;
    if (s.empty() || s.front() == '[') useLong = false;
    if (useLong) {
        for (size_t i = 0; i + 1 < s.size(); ++i) {
            if (s[i] == ']' && s[i + 1] == ']') { useLong = false; break; }
            if (s[i] == '\n' || s[i] == '\r') { useLong = false; break; }
        }
    }
    if (useLong) {
        std::string out;
        out.reserve(s.size() + 4);
        out += "[[";
        out.append(s.data(), s.size());
        out += "]]";
        return out;
    }
    // Escape format
    std::string out;
    out.reserve(s.size() + 4);
    out += '"';
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\%d", static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    out += '"';
    return out;
}

std::string LuaNumber(double v)
{
    // Non-finite values: emit as 0. The engine has a few NaN/Inf
    // warnings during ZK's unitdefs_post.lua (e.g.
    // bomberassault.repairspeed) and matching FB behaviour (silent
    // float storage) would require Lua's `0/0` literal — but the
    // client doesn't handle NaN sensibly anywhere so collapse to 0.
    if (!std::isfinite(v)) return "0";

    // Integer-valued: emit without decimal point when representable
    // exactly in 64-bit. Keeps `metalCost=1500` instead of `1500.0`.
    if (v == std::trunc(v) && std::abs(v) < 1e15) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(v));
        return buf;
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%.17g", v);
    return buf;
}

std::string LuaNumber(float v) { return LuaNumber(static_cast<double>(v)); }

// ─── Brotli compression ───────────────────────────────────────────

std::vector<uint8_t> CompressBrotli(std::string_view input, int quality)
{
    size_t encodedSize = BrotliEncoderMaxCompressedSize(input.size());
    if (encodedSize == 0) {
        throw std::runtime_error("brotli: input too large");
    }
    std::vector<uint8_t> out(encodedSize);
    const BROTLI_BOOL ok = BrotliEncoderCompress(
        quality,
        BROTLI_DEFAULT_WINDOW,
        BROTLI_MODE_TEXT,
        input.size(),
        reinterpret_cast<const uint8_t*>(input.data()),
        &encodedSize,
        out.data());
    if (!ok) {
        throw std::runtime_error("brotli: encode failed");
    }
    out.resize(encodedSize);
    return out;
}

// ─── LuaBuilder — accumulate key/value pairs, sort, emit ─────────

namespace detail {

void LuaBuilder::add_raw(const char* key, std::string val)
{
    pairs_.emplace_back(key, std::move(val));
}

void LuaBuilder::add_str(const char* key, std::string_view val,
                         std::string_view def)
{
    if (val == def) return;
    pairs_.emplace_back(key, LuaQuote(val));
}

void LuaBuilder::add_float(const char* key, double val, double def)
{
    if (val == def) return;
    pairs_.emplace_back(key, LuaNumber(val));
}

void LuaBuilder::add_int(const char* key, long long val, long long def)
{
    if (val == def) return;
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%lld", val);
    pairs_.emplace_back(key, buf);
}

void LuaBuilder::add_bool(const char* key, bool val, bool def)
{
    if (val == def) return;
    pairs_.emplace_back(key, val ? "true" : "false");
}

std::string LuaBuilder::finish()
{
    std::sort(pairs_.begin(), pairs_.end(),
        [](const auto& a, const auto& b) { return a.first < b.first; });
    std::string out;
    out.reserve(64 + pairs_.size() * 32);
    out += '{';
    for (size_t i = 0; i < pairs_.size(); ++i) {
        if (i > 0) out += ',';
        const auto& [k, v] = pairs_[i];
        if (IsLuaIdent(k)) {
            out += k;
        } else {
            out += '[';
            out += LuaQuote(k);
            out += ']';
        }
        out += '=';
        out += v;
    }
    out += '}';
    return out;
}

/// Emit an int-vector as `{1,2,3}`. Always emits — caller should
/// skip the field when the vector is empty.
std::string IntVector(const std::vector<uint16_t>& vec)
{
    std::string out;
    out.reserve(2 + vec.size() * 5);
    out += '{';
    for (size_t i = 0; i < vec.size(); ++i) {
        if (i > 0) out += ',';
        char buf[8];
        std::snprintf(buf, sizeof(buf), "%u", static_cast<unsigned>(vec[i]));
        out += buf;
    }
    out += '}';
    return out;
}

std::string FloatVector(const std::vector<float>& vec)
{
    std::string out;
    out.reserve(2 + vec.size() * 8);
    out += '{';
    for (size_t i = 0; i < vec.size(); ++i) {
        if (i > 0) out += ',';
        out += LuaNumber(vec[i]);
    }
    out += '}';
    return out;
}

/// Emit a string→string map as a Lua table with bare-ident keys
/// where possible, `["key"]` form otherwise. Keys are sorted
/// alphabetically for stable diffs.
std::string StringMap(const std::vector<std::pair<std::string, std::string>>& kvs)
{
    auto sorted = kvs;
    std::sort(sorted.begin(), sorted.end(),
        [](const auto& a, const auto& b) { return a.first < b.first; });
    std::string out;
    out.reserve(2 + sorted.size() * 24);
    out += '{';
    for (size_t i = 0; i < sorted.size(); ++i) {
        if (i > 0) out += ',';
        if (IsLuaIdent(sorted[i].first)) {
            out += sorted[i].first;
        } else {
            out += '[';
            out += LuaQuote(sorted[i].first);
            out += ']';
        }
        out += '=';
        out += LuaQuote(sorted[i].second);
    }
    out += '}';
    return out;
}

} // namespace detail

// ─── Feature defs ─────────────────────────────────────────────────

std::string SerializeFeatureDefs(
    const std::vector<FeatureDef>& defs,
    const std::string& gameId,
    const std::filesystem::path& modelsDir)
{
    namespace fs = std::filesystem;
    std::string out;
    out.reserve(8192);
    out += "return{base_url=[[]],defs={";

    bool firstDef = true;
    for (size_t i = 0; i < defs.size(); ++i) {
        const FeatureDef& fd = defs[i];
        // Slot 0 sentinel "no def" — match FB BuildGameFeatureDefs.
        if (fd.id <= 0) continue;

        std::string modelUrl;
        if (!fd.modelName.empty() && !gameId.empty()) {
            const std::string stem = fs::path(fd.modelName).stem().string();
            const fs::path gltfPath = modelsDir / (stem + ".gltf");
            if (fs::exists(gltfPath)) {
                modelUrl = "/api/games/data/" + gameId + "/models/" + stem + ".gltf";
            }
        }

        std::vector<std::pair<std::string, std::string>> cps;
        cps.reserve(fd.customParams.size());
        for (const auto& kv : fd.customParams) {
            cps.emplace_back(kv.first, kv.second);
        }

        detail::LuaBuilder b;
        b.add_int("def_id", static_cast<long long>(fd.id));
        b.add_str("name", fd.name);
        b.add_str("model_url", modelUrl);
        // texture_url + script_name were always emitted as "" by the
        // FB serializer — skip (default).
        b.add_int("draw_type", fd.drawType);
        b.add_int("footprint_x", fd.xsize);
        b.add_int("footprint_z", fd.zsize);
        b.add_float("radius", fd.GetModelRadius());
        b.add_float("mass", fd.mass);
        b.add_float("health", fd.health);
        b.add_bool("blocking", fd.collidable);
        b.add_bool("reclaimable", fd.reclaimable);
        b.add_bool("destructable", fd.destructable);
        b.add_bool("burnable", fd.burnable);
        b.add_bool("floating", fd.floating);
        b.add_bool("geo_thermal", fd.geoThermal);
        b.add_float("metal", fd.cost.metal);
        b.add_float("energy", fd.cost.energy);
        b.add_int("death_feature_def_id",
                  static_cast<long long>(std::max(0, fd.deathFeatureDefID)));
        b.add_float("smoke_time", fd.smokeTime);
        b.add_float("reclaim_time", fd.reclaimTime);
        if (!cps.empty()) {
            b.add_raw("custom_params", detail::StringMap(cps));
        }

        if (!firstDef) out += ',';
        firstDef = false;
        out += b.finish();
    }
    out += "}}";
    return out;
}

// ─── CEG defs ─────────────────────────────────────────────────────

std::string SerializeCegDefs(const std::vector<CegLoader::CegDef>& defs)
{
    std::string out;
    out.reserve(8192);
    out += "return{defs={";

    bool firstDef = true;
    for (const auto& def : defs) {
        if (!firstDef) out += ',';
        firstDef = false;

        detail::LuaBuilder b;
        b.add_str("tag", def.tag);
        b.add_bool("use_default_explosions", def.useDefaultExplosions);

        // Ground flash subtable — only when authored (ttl > 0).
        if (def.groundFlash.ttl > 0) {
            detail::LuaBuilder gf;
            gf.add_int("ttl", def.groundFlash.ttl);
            gf.add_float("circle_alpha", def.groundFlash.circleAlpha);
            gf.add_float("flash_size", def.groundFlash.flashSize);
            gf.add_float("flash_alpha", def.groundFlash.flashAlpha);
            gf.add_float("circle_growth", def.groundFlash.circleGrowth);
            // Match FB defaults: color defaults to (1, 1, 0.8); only
            // emit when something is non-default. To match wire-for-
            // wire we always emit because the FB writer always sets
            // these fields.
            gf.add_raw("color_r", LuaNumber(def.groundFlash.colorR));
            gf.add_raw("color_g", LuaNumber(def.groundFlash.colorG));
            gf.add_raw("color_b", LuaNumber(def.groundFlash.colorB));
            gf.add_int("flags", def.groundFlash.flags);
            b.add_raw("ground_flash", gf.finish());
        }

        // Spawns array — preserve source order (FB does too).
        std::string spawnsArr = "{";
        for (size_t s = 0; s < def.spawns.size(); ++s) {
            if (s > 0) spawnsArr += ',';
            const auto& spawn = def.spawns[s];
            detail::LuaBuilder sb;
            sb.add_str("spawn_name", spawn.spawnName);
            sb.add_str("class_name", spawn.className);
            sb.add_int("count", spawn.count);
            sb.add_int("flags", spawn.flags);
            if (!spawn.properties.empty()) {
                std::vector<std::pair<std::string, std::string>> props;
                props.reserve(spawn.properties.size());
                for (const auto& p : spawn.properties) {
                    props.emplace_back(p.key, p.value);
                }
                sb.add_raw("properties", detail::StringMap(props));
            }
            spawnsArr += sb.finish();
        }
        spawnsArr += '}';
        b.add_raw("spawns", spawnsArr);

        out += b.finish();
    }
    out += "}}";
    return out;
}

} // namespace LuaDefsSerializer
