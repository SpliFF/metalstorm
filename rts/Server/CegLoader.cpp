#include "CegLoader.h"

#include "protocol_generated.h"

#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Lua/LuaParser.h"
#include "System/Log/ILog.h"

#include <flatbuffers/flatbuffers.h>

#include <algorithm>
#include <cctype>
#include <cstdio>

namespace CegLoader {

namespace {

/// Lowercase a string in-place. CEG tags + spawn keys are
/// case-insensitive on the engine side; matching Lua-handler
/// behaviour by lowercasing on serialisation keeps lookups simple
/// for the client.
std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

// Forward declaration — string-keyed and int-keyed accessors recurse
// into one another when the underlying value is a sub-table whose
// elements may themselves be tables. Defining the int-keyed variant
// first would just push the same forward decl up the file.
std::string GetValueAsStringInt(const LuaTable& tbl, int key);

/// Convert a LuaTable value at `key` to a string, regardless of source
/// type. The CEG language is permissive — gravity may be a vec3 string
/// `[[0, 2, 0]]`, a single number, or even `[[r-2, 4, r3]]` with random
/// expressions. We forward whatever shape the author used, and the
/// client decodes per-property based on its class.
std::string GetValueAsString(const LuaTable& tbl, const std::string& key) {
    const LuaTable::DataType type = tbl.GetType(key);
    switch (type) {
        case LuaTable::BOOLEAN: {
            return tbl.GetBool(key, false) ? "1" : "0";
        }
        case LuaTable::NUMBER: {
            // Floats are common (gravity = 2.5). Use %g for compactness.
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%g", tbl.GetFloat(key, 0.0f));
            return buf;
        }
        case LuaTable::STRING: {
            return tbl.GetString(key, "");
        }
        case LuaTable::TABLE: {
            // Lua list expressed as a sub-table. Serialize as
            // comma-separated values so the client can `split(',')`.
            const LuaTable sub = tbl.SubTable(key);
            std::vector<int> intKeys;
            sub.GetKeys(intKeys);
            std::string out;
            for (size_t i = 0; i < intKeys.size(); i++) {
                if (i > 0) out += ",";
                out += GetValueAsStringInt(sub, intKeys[i]);
            }
            return out;
        }
        default:
            return "";
    }
}

/// Variant: integer-keyed access (for serialising list-style sub-tables).
std::string GetValueAsStringInt(const LuaTable& tbl, int key) {
    const LuaTable::DataType type = tbl.GetType(key);
    switch (type) {
        case LuaTable::BOOLEAN: return tbl.GetBool(key, false) ? "1" : "0";
        case LuaTable::NUMBER: {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%g", tbl.GetFloat(key, 0.0f));
            return buf;
        }
        case LuaTable::STRING: return tbl.GetString(key, "");
        case LuaTable::TABLE: {
            const LuaTable sub = tbl.SubTable(key);
            std::vector<int> intKeys;
            sub.GetKeys(intKeys);
            std::string out;
            for (size_t i = 0; i < intKeys.size(); i++) {
                if (i > 0) out += ",";
                out += GetValueAsStringInt(sub, intKeys[i]);
            }
            return out;
        }
        default: return "";
    }
}

/// Pack the visibility-context booleans into a single uint8_t. CEG
/// authors sometimes use `1`/`0`, sometimes `true`/`false`; the engine
/// treats both as boolean. Missing keys default to false.
uint8_t ReadFlags(const LuaTable& spawn) {
    uint8_t flags = 0;
    if (spawn.GetBool("ground",     false)) flags |= CEG_FLAG_GROUND;
    if (spawn.GetBool("air",        false)) flags |= CEG_FLAG_AIR;
    if (spawn.GetBool("water",      false)) flags |= CEG_FLAG_WATER;
    if (spawn.GetBool("unit",       false)) flags |= CEG_FLAG_UNIT;
    if (spawn.GetBool("underwater", false)) flags |= CEG_FLAG_UNDERWATER;
    return flags;
}

/// Skip-list for keys that aren't real spawn entries. `filename` is
/// stamped on every CEG by springcontent's loader; `useDefaultExplosions`
/// is consumed at the CEG level (we lift it out before iterating).
bool IsReservedSpawnKey(const std::string& key) {
    if (key == "filename" || key == "useDefaultExplosions") return true;
    // `groundflash` is a Spring shorthand the engine compiles into a
    // CSimpleGroundFlash spawn — but only on the renderer. The headless
    // server's CCustomExplosionGenerator::Load skips it explicitly.
    // We still ship it: the client's CSimpleGroundFlash mapper handles
    // it identically to an explicitly-classed spawn.
    return false;
}

/// One spawn = one sub-table inside a CEG. Returns false if the entry
/// isn't a real spawn (skipped key, missing class) so the caller can
/// drop it without mistaking the empty struct for valid output.
bool ReadSpawn(const std::string& spawnName, const LuaTable& spawn,
               const ClassAliasList& aliases, CegSpawn& out)
{
    if (IsReservedSpawnKey(spawnName)) return false;
    if (!spawn.IsValid()) return false;

    const std::string rawClass = spawn.GetString("class", spawnName);
    const std::string resolved = aliases.ResolveAlias(rawClass);
    if (resolved.empty()) return false;

    out.spawnName = ToLower(spawnName);
    out.className = resolved;
    out.count = std::max(0, spawn.GetInt("count", 1));
    out.flags = ReadFlags(spawn);

    // Properties block. Empty for some CEGs (e.g. CExpGenSpawner without
    // override params). Flatten to (key, stringified-value) pairs.
    spring::unordered_map<std::string, std::string> propMap;
    spawn.SubTable("properties").GetMap(propMap);
    out.properties.reserve(propMap.size());
    for (const auto& kv : propMap) {
        out.properties.push_back({ ToLower(kv.first), kv.second });
    }
    // Some authors put structured values (vec3 lists) at the table
    // level; GetMap above already serialises strings. For Lua-list
    // values we re-walk via GetValueAsString to preserve them.
    std::vector<std::string> propKeys;
    spawn.SubTable("properties").GetKeys(propKeys);
    for (const auto& key : propKeys) {
        if (propMap.find(key) != propMap.end()) continue; // already handled
        const std::string val = GetValueAsString(spawn.SubTable("properties"), key);
        if (!val.empty()) {
            out.properties.push_back({ ToLower(key), val });
        }
    }

    return true;
}

} // anonymous namespace

std::vector<CegDef> LoadAllCegDefs()
{
    std::vector<CegDef> result;

    const LuaTable* root = explGenHandler.GetExplosionTableRoot();
    if (root == nullptr || !root->IsValid()) {
        LOG_L(L_INFO, "[CegLoader] no explosion table parsed (no CEGs to ship)");
        return result;
    }

    const ClassAliasList& aliases = explGenHandler.GetProjectileClasses();

    std::vector<std::string> tags;
    root->GetKeys(tags);
    result.reserve(tags.size());

    for (const std::string& tag : tags) {
        const LuaTable cegTable = root->SubTable(tag);
        if (!cegTable.IsValid()) continue;

        CegDef def;
        def.tag = ToLower(tag);
        def.useDefaultExplosions = cegTable.GetBool("useDefaultExplosions", false);

        std::vector<std::string> spawnKeys;
        cegTable.GetKeys(spawnKeys);
        def.spawns.reserve(spawnKeys.size());

        for (const std::string& spawnKey : spawnKeys) {
            CegSpawn spawn;
            if (ReadSpawn(spawnKey, cegTable.SubTable(spawnKey), aliases, spawn)) {
                def.spawns.push_back(std::move(spawn));
            }
        }

        // Skip CEGs with no usable spawns. Some authors leave commented-
        // out skeletons (filename + nothing else); shipping them wastes
        // bandwidth and the client would no-op anyway.
        if (def.spawns.empty() && !def.useDefaultExplosions) continue;

        result.push_back(std::move(def));
    }

    LOG_L(L_NOTICE, "[CegLoader] loaded %zu CEG def(s) from explosion table",
          result.size());
    return result;
}

std::vector<uint8_t> BuildGameCegDefs(const std::vector<CegDef>& defs)
{
    flatbuffers::FlatBufferBuilder fbb(64 * 1024);

    std::vector<flatbuffers::Offset<SpringWeb::GameCegDef>> defOffsets;
    defOffsets.reserve(defs.size());

    for (const CegDef& def : defs) {
        std::vector<flatbuffers::Offset<SpringWeb::GameCegSpawn>> spawnOffsets;
        spawnOffsets.reserve(def.spawns.size());

        for (const CegSpawn& spawn : def.spawns) {
            std::vector<flatbuffers::Offset<SpringWeb::CegProperty>> propOffsets;
            propOffsets.reserve(spawn.properties.size());
            for (const auto& prop : spawn.properties) {
                auto kOff = fbb.CreateString(prop.key);
                auto vOff = fbb.CreateString(prop.value);
                propOffsets.push_back(SpringWeb::CreateCegProperty(fbb, kOff, vOff));
            }

            auto nameOff  = fbb.CreateString(spawn.spawnName);
            auto classOff = fbb.CreateString(spawn.className);
            auto propsVec = fbb.CreateVector(propOffsets);

            SpringWeb::GameCegSpawnBuilder sb(fbb);
            sb.add_spawn_name(nameOff);
            sb.add_class_name(classOff);
            sb.add_count(spawn.count);
            sb.add_flags(spawn.flags);
            sb.add_properties(propsVec);
            spawnOffsets.push_back(sb.Finish());
        }

        auto tagOff = fbb.CreateString(def.tag);
        auto spawnsVec = fbb.CreateVector(spawnOffsets);

        SpringWeb::GameCegDefBuilder db(fbb);
        db.add_tag(tagOff);
        db.add_spawns(spawnsVec);
        db.add_use_default_explosions(def.useDefaultExplosions);
        defOffsets.push_back(db.Finish());
    }

    auto defsVec = fbb.CreateVector(defOffsets);
    auto msg = SpringWeb::CreateGameCegDefs(fbb, defsVec);

    // Wrap in a ServerMessage envelope so the client's
    // ingestFramedMessage path picks it up as a normal payload.
    auto sm = SpringWeb::CreateServerMessage(fbb,
        SpringWeb::ServerPayload_GameCegDefs, msg.Union());
    fbb.Finish(sm);

    // Prefix with the FlatBuffer envelope byte (0x01) — same as
    // Protocol::BuildServerMessage.
    constexpr uint8_t ENVELOPE_FLATBUFFERS = 0x01;
    std::vector<uint8_t> out;
    const uint8_t* fbBytes = fbb.GetBufferPointer();
    const size_t fbSize = fbb.GetSize();
    out.reserve(1 + fbSize);
    out.push_back(ENVELOPE_FLATBUFFERS);
    out.insert(out.end(), fbBytes, fbBytes + fbSize);
    return out;
}

} // namespace CegLoader
