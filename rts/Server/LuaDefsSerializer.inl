/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/* Template implementations for LuaDefsSerializer::SerializeUnitDefs +
 * SerializeWeaponDefs. Included from LuaDefsSerializer.h.
 *
 * These are templates so the same code compiles against both the
 * engine's runtime UnitDef / WeaponDef classes and test-fixture
 * stand-ins. Mirrors the FlatBuffer serializers in Protocol.h
 * (BuildSingleUnitDef + BuildSingleWeaponDef) field-for-field; see
 * the matching FB code for field-derivation logic that's identical
 * here.
 */

#ifndef LUA_DEFS_SERIALIZER_INL
#define LUA_DEFS_SERIALIZER_INL

#include "Server/ProjectileTextureDefaults.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>
#include <unordered_map>
#include <utility>
#include <vector>

namespace LuaDefsSerializer {

// ─── name → def-id helper (mirrors BuildNameToDefIdMap) ───────────

template<typename UnitDefVec>
inline std::unordered_map<std::string, int> BuildNameToDefIdMap_(const UnitDefVec& defs)
{
    std::unordered_map<std::string, int> out;
    out.reserve(defs.size());
    for (size_t i = 1; i < defs.size(); ++i) {
        if (defs[i].id > 0) out.emplace(defs[i].name, defs[i].id);
    }
    return out;
}

// ─── Unit defs ────────────────────────────────────────────────────

template<typename UnitDefT>
inline std::string SerializeOneUnitDef(
    const UnitDefT& ud,
    const std::filesystem::path& modelsDir,
    const std::string& gameId,
    const std::unordered_map<std::string, int>& nameToDefId)
{
    namespace fs = std::filesystem;

    // Model URL — only when the .gltf actually exists on disk.
    std::string modelUrl;
    if (!ud.modelName.empty()) {
        const std::string stem = fs::path(ud.modelName).stem().string();
        const fs::path gltfPath = modelsDir / (stem + ".gltf");
        if (fs::exists(gltfPath)) {
            modelUrl = "/api/games/data/" + gameId + "/models/" + stem + ".gltf";
        }
    }

    // Packed behaviour flags — bit assignments match
    // schemas/protocol.fbs GameUnitDef.flags (so the existing decoder
    // semantics on the client carry over directly).
    uint32_t flags = 0;
    if (ud.builder)          flags |= (1u <<  0);
    if (ud.canmove)          flags |= (1u <<  1);
    if (ud.canfly)           flags |= (1u <<  2);
    if (ud.canSubmerge)      flags |= (1u <<  3);
    if (ud.floatOnWater)     flags |= (1u <<  4);
    if (ud.canCloak)         flags |= (1u <<  5);
    if (ud.canKamikaze)      flags |= (1u <<  6);
    if (ud.canManualFire)    flags |= (1u <<  7);
    if (ud.stealth)          flags |= (1u <<  8);
    if (ud.sonarStealth)     flags |= (1u <<  9);
    if (ud.reclaimable)      flags |= (1u << 10);
    if (ud.IsFactoryUnit())  flags |= (1u << 11);
    if (ud.IsBuildingUnit()) flags |= (1u << 12);
    if (ud.IsAirUnit())      flags |= (1u << 13);
    if (ud.IsExtractorUnit())flags |= (1u << 14);
    if (ud.HasWeapons())     flags |= (1u << 15);

    // Build options → numeric def IDs in slot order.
    std::vector<uint16_t> buildOptions;
    if (!ud.buildOptions.empty() && !nameToDefId.empty()) {
        std::vector<std::pair<int, const std::string*>> slots;
        slots.reserve(ud.buildOptions.size());
        for (const auto& kv : ud.buildOptions) {
            slots.emplace_back(kv.first, &kv.second);
        }
        std::sort(slots.begin(), slots.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
        buildOptions.reserve(slots.size());
        for (const auto& s : slots) {
            auto it = nameToDefId.find(*s.second);
            if (it != nameToDefId.end() && it->second > 0) {
                buildOptions.push_back(static_cast<uint16_t>(it->second));
            }
        }
    }

    // Weapon def IDs in slot order, trailing zeros trimmed.
    std::vector<uint16_t> weaponDefIds;
    weaponDefIds.reserve(ud.weapons.size());
    for (const auto& w : ud.weapons) {
        weaponDefIds.push_back(
            w.def != nullptr ? static_cast<uint16_t>(w.def->id) : 0u);
    }
    while (!weaponDefIds.empty() && weaponDefIds.back() == 0) {
        weaponDefIds.pop_back();
    }

    // Yardmap — digit string, one char per cell.
    std::string yardmapStr;
    yardmapStr.reserve(ud.yardmap.size());
    for (auto status : ud.yardmap) {
        yardmapStr.push_back(static_cast<char>('0' + static_cast<int>(status)));
    }

    // Custom params → vector of (k, v) pairs for the sorted emitter.
    std::vector<std::pair<std::string, std::string>> cps;
    cps.reserve(ud.customParams.size());
    for (const auto& kv : ud.customParams) {
        cps.emplace_back(kv.first, kv.second);
    }

    detail::LuaBuilder b;
    b.add_int("def_id", static_cast<long long>(ud.id));
    b.add_str("name", ud.name);
    b.add_str("model_url", modelUrl);
    // texture_url was always "" in FB — skip (default).
    b.add_str("human_name", ud.humanName);
    b.add_str("tooltip", ud.tooltip);
    b.add_str("wreck_name", ud.wreckName);
    b.add_float("metal_cost", ud.cost.metal);
    b.add_float("energy_cost", ud.cost.energy);
    b.add_float("build_time", ud.buildTime);
    b.add_float("metal_make", ud.resourceMake.metal);
    b.add_float("energy_make", ud.resourceMake.energy);
    b.add_float("metal_upkeep", ud.upkeep.metal);
    b.add_float("energy_upkeep", ud.upkeep.energy);
    b.add_float("metal_storage", ud.storage.metal);
    b.add_float("energy_storage", ud.storage.energy);
    b.add_float("extracts_metal", ud.extractsMetal);
    b.add_float("health", ud.health);
    b.add_float("mass", ud.mass);
    b.add_float("radius", ud.GetModelRadius());
    b.add_int("xsize", ud.xsize);
    b.add_int("zsize", ud.zsize);
    b.add_float("speed", ud.speed);
    b.add_float("turn_rate", ud.turnRate);
    b.add_float("max_acc", ud.maxAcc);
    b.add_float("max_dec", ud.maxDec);
    // move_def_path_type defaults to UINT32_MAX in the schema
    // (UnitDef stores -1U for air / immobile units); only emit when
    // it's a real path-type id.
    if (ud.pathType != static_cast<uint32_t>(-1)) {
        b.add_int("move_def_path_type", static_cast<long long>(ud.pathType));
    }
    b.add_float("los_radius", ud.losRadius);
    b.add_float("air_los_radius", ud.airLosRadius);
    b.add_int("radar_radius", ud.radarRadius);
    b.add_int("sonar_radius", ud.sonarRadius);
    b.add_int("jammer_radius", ud.jammerRadius);
    b.add_int("seismic_radius", ud.seismicRadius);
    b.add_int("flags", static_cast<long long>(flags));
    b.add_float("build_distance", ud.buildDistance);
    b.add_float("build_speed", ud.buildSpeed);
    if (!buildOptions.empty()) {
        b.add_raw("build_options", detail::IntVector(buildOptions));
    }
    if (!weaponDefIds.empty()) {
        b.add_raw("weapon_def_ids", detail::IntVector(weaponDefIds));
    }
    if (!cps.empty()) {
        b.add_raw("custom_params", detail::StringMap(cps));
    }
    b.add_float("repair_speed", ud.repairSpeed);
    b.add_int("transport_size", ud.transportSize);
    b.add_float("transport_mass", ud.transportMass);
    b.add_int("transport_capacity", ud.transportCapacity);
    b.add_str("yardmap", yardmapStr);
    b.add_str("script", ud.scriptName);
    b.add_str("build_pic", ud.buildPicName);
    // Vehicle tread-track type (lowercased) — only for track-leaving movers.
    // The client builds the same sorted distinct set from these names to
    // resolve the wire trackTypeId (envelope 0x08) → track texture. Omitted
    // for non-track units so the client's distinct set matches the server's
    // (ServerTrackEmitter) index-for-index. Not render-only data: it's a
    // SolidObjectDecalDef field the sim already parses.
    if (ud.decalDef.leaveTrackDecals && !ud.decalDef.trackDecalTypeName.empty()) {
        std::string tt = ud.decalDef.trackDecalTypeName;
        for (char& c : tt)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        b.add_str("track_type", tt);
    }
    b.add_float("max_velocity", ud.speed);  // FB: same as speed
    b.add_float("cost", ud.cost.metal + ud.cost.energy);
    b.add_float("max_weapon_range", ud.maxWeaponRange);
    b.add_int("max_this_unit", ud.maxThisUnit);
    // bools — FB defaults to true for both, so emit when false.
    b.add_bool("can_be_assisted", ud.canBeAssisted, /*def=*/true);
    b.add_bool("can_self_destruct", ud.canSelfD,    /*def=*/true);
    b.add_int("self_d_countdown", ud.selfDCountdown);
    b.add_int("category_bits", static_cast<long long>(ud.category));

    // Sounds: emit a Lua array of {id, path, name, category,
    // volume, pitch} tables in the same packing order as the FB
    // AppendSoundRefs helper used. We replicate the category sequence
    // verbatim (select / ok / arrived / build / repair / working /
    // underattack / cant / activate / deactivate).
    // Empty when the unitdef has no sounds — skip the field then.
    {
        uint16_t nextId = 0;
        std::string soundsArr;
        soundsArr.reserve(128);
        soundsArr += '{';
        bool firstSnd = true;
        auto appendCategory = [&](const auto& soundSet, int categoryCode) {
            for (size_t i = 0; i < soundSet.NumSounds(); ++i) {
                const auto& d = soundSet.GetSoundData(static_cast<int>(i));
                if (d.name.empty()) continue;
                if (!firstSnd) soundsArr += ',';
                firstSnd = false;
                detail::LuaBuilder sb;
                sb.add_int("id", nextId++);
                // path normalisation matches NormalizeSoundPath behaviour
                // in Protocol.h — convert backslashes + lowercase + add
                // sounds/ prefix if absent. We delegate to the same
                // helper visible in the FB serializer via friend or
                // explicit forward (here we inline a minimal version).
                std::string p = d.name;
                std::replace(p.begin(), p.end(), '\\', '/');
                std::transform(p.begin(), p.end(), p.begin(),
                    [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
                if (p.find("sounds/") != 0 &&
                    p.find('.') == std::string::npos) {
                    // identical to engine behaviour: prefix sounds/
                    // when the path is a bare name without extension.
                    p = "sounds/" + p;
                }
                sb.add_str("path", p);
                sb.add_str("name", d.name);
                sb.add_int("category", categoryCode);
                const float vol = (d.volume > 0.0f)
                    ? std::min(d.volume, 4.0f) : 1.0f;
                sb.add_float("volume", vol, /*def=*/1.0);
                sb.add_float("pitch", 1.0, /*def=*/1.0);
                soundsArr += sb.finish();
            }
        };
        // SoundCategory enum values from schemas/protocol.fbs:
        //   Select=0, OrderAck=1, Move=2, BuildStart=3, Working=4,
        //   Idle=5, Cancel=6, Activate=7, Deactivate=8, ...
        appendCategory(ud.sounds.select,      0);
        appendCategory(ud.sounds.ok,          1);
        appendCategory(ud.sounds.arrived,     2);
        appendCategory(ud.sounds.build,       3);
        appendCategory(ud.sounds.repair,      4);
        appendCategory(ud.sounds.working,     4);
        appendCategory(ud.sounds.underattack, 5);
        appendCategory(ud.sounds.cant,        6);
        appendCategory(ud.sounds.activate,    7);
        appendCategory(ud.sounds.deactivate,  8);
        soundsArr += '}';
        if (nextId > 0) {
            b.add_raw("sounds", std::move(soundsArr));
        }
    }

    return b.finish();
}

template<typename UnitDefVec>
inline std::string SerializeUnitDefs(
    const UnitDefVec& defs,
    const std::string& gameId)
{
    namespace fs = std::filesystem;
    const fs::path modelsDir = fs::path("data/games") / gameId / "models";
    const auto nameToId = BuildNameToDefIdMap_(defs);

    std::string out;
    out.reserve(defs.size() * 512);
    out += "return{base_url=[[]],defs={";
    bool first = true;
    // Skip slot 0 — the sentinel "no def" entry. Matches FB
    // BuildGameUnitDefs starting its loop at i=1.
    for (size_t i = 1; i < defs.size(); ++i) {
        if (!first) out += ',';
        first = false;
        out += SerializeOneUnitDef(defs[i], modelsDir, gameId, nameToId);
    }
    out += "}}";
    return out;
}

// ─── Weapon defs ──────────────────────────────────────────────────

template<typename WeaponDefT>
inline std::string SerializeOneWeaponDef(
    const WeaponDefT& wd,
    const std::filesystem::path& modelsDir,
    const std::string& gameId,
    const std::unordered_set<std::string>* projectileTextureNames)
{
    namespace fs = std::filesystem;

    std::string modelUrl;
    if (!wd.visuals.modelName.empty() && !gameId.empty()) {
        const std::string stem = fs::path(wd.visuals.modelName).stem().string();
        const fs::path gltfPath = modelsDir / (stem + ".gltf");
        if (fs::exists(gltfPath)) {
            modelUrl = "/api/games/data/" + gameId + "/models/" + stem + ".gltf";
        }
    }

    // texture1/2/3 with per-weaponType defaults — use the shared
    // helper from ProjectileTextureDefaults.h. Fully-qualified to
    // global scope so we don't pick up an unrelated symbol from any
    // enclosing namespace.
    std::array<std::string, 4> srcTex{
        wd.visuals.texNames[0], wd.visuals.texNames[1],
        wd.visuals.texNames[2], wd.visuals.texNames[3],
    };
    const auto resolvedTex = ::ResolveProjectileTextureDefaults(
        wd.type, wd.largeBeamLaser, srcTex, projectileTextureNames);

    // Strip the `custom:` prefix on CEG tags + lowercase to match
    // BuildSingleWeaponDef's stripCustomLower behaviour.
    auto stripCustomLower = [](const std::string& tag) -> std::string {
        constexpr const char* kPrefix = "custom:";
        constexpr size_t kPrefixLen = 7;
        std::string s = (tag.size() >= kPrefixLen
            && std::strncmp(tag.c_str(), kPrefix, kPrefixLen) == 0)
            ? tag.substr(kPrefixLen) : tag;
        std::transform(s.begin(), s.end(), s.begin(),
            [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
        return s;
    };

    // Damage table — only emit when armor classes diverge from default.
    std::vector<float> damages;
    bool varies = false;
    const float defDmg = wd.damages.GetDefault();
    const int numTypes = wd.damages.GetNumTypes();
    damages.reserve(numTypes);
    for (int ai = 0; ai < numTypes; ++ai) {
        const float d = wd.damages.Get(ai);
        damages.push_back(d);
        if (d != defDmg) varies = true;
    }
    if (!varies) damages.clear();

    // Packed flag bits — assignments match GameWeaponDef.flags in
    // schemas/protocol.fbs.
    uint32_t flags = 0;
    if (wd.tracks)          flags |= (1u <<  0);
    if (wd.paralyzer)       flags |= (1u <<  1);
    if (wd.noSelfDamage)    flags |= (1u <<  2);
    if (wd.manualfire)      flags |= (1u <<  3);
    if (wd.noAutoTarget)    flags |= (1u <<  4);
    if (wd.stockpile)       flags |= (1u <<  5);
    if (wd.waterweapon)     flags |= (1u <<  6);
    if (wd.fireSubmersed)   flags |= (1u <<  7);
    if (wd.submissile)      flags |= (1u <<  8);
    if (wd.turret)          flags |= (1u <<  9);
    if (wd.onlyForward)     flags |= (1u << 10);
    if (wd.fixedLauncher)   flags |= (1u << 11);
    if (wd.canAttackGround) flags |= (1u << 12);
    if (wd.avoidFriendly)   flags |= (1u << 13);
    if (wd.avoidFeature)    flags |= (1u << 14);
    if (wd.avoidNeutral)    flags |= (1u << 15);
    if (wd.gravityAffected) flags |= (1u << 16);
    if (wd.noExplode)       flags |= (1u << 17);
    if (wd.largeBeamLaser)  flags |= (1u << 18);
    if (wd.laserHardStop)   flags |= (1u << 19);
    if (wd.isShield)        flags |= (1u << 20);
    if (wd.smartShield)     flags |= (1u << 21);
    if (wd.exteriorShield)  flags |= (1u << 22);
    if (wd.visibleShield)   flags |= (1u << 23);

    std::vector<std::pair<std::string, std::string>> cps;
    cps.reserve(wd.customParams.size());
    for (const auto& kv : wd.customParams) {
        cps.emplace_back(kv.first, kv.second);
    }

    detail::LuaBuilder b;
    b.add_int("def_id", static_cast<long long>(wd.id));
    b.add_str("name", wd.name);
    // Recoil's WEAPON_*_PROJECTILE bitmask (see
    // Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h). The
    // client mirrors the same enum and dispatches each value to its
    // own visual builder.
    b.add_int("projectile_type", static_cast<int>(wd.projectileType));
    b.add_float("projectile_speed", wd.projectilespeed);
    b.add_float("range", wd.range);
    b.add_float("aoe", wd.damages.damageAreaOfEffect);
    b.add_float("size", wd.size);
    b.add_float("intensity", wd.intensity);
    b.add_float("color_r", wd.visuals.color.x);
    b.add_float("color_g", wd.visuals.color.y);
    b.add_float("color_b", wd.visuals.color.z);
    // Recoil renders the inner core of laser bolts / beams with a
    // second colour. Defaults to white when the modder leaves it out.
    b.add_float("color2_r", wd.visuals.color2.x);
    b.add_float("color2_g", wd.visuals.color2.y);
    b.add_float("color2_b", wd.visuals.color2.z);
    // Outer half-width (elmos) and core-to-outer ratio. Used by the
    // LaserCannon / BeamLaser builders to size the shaft + core quads.
    b.add_float("thickness", wd.visuals.thickness);
    b.add_float("core_thickness", wd.visuals.corethickness);
    // Whether CLaserProjectile stops + contracts at max range instead
    // of fading out. Drives the post-impact stayTime path.
    b.add_bool("laser_hard_stop", wd.laserHardStop);
    // Fade-out rate for non-hardstop lasers.
    b.add_float("falloff_rate", wd.falloffRate);
    b.add_float("duration", wd.duration);
    b.add_bool("high_trajectory", wd.highTrajectory == 1);

    b.add_str("type_name", wd.type);
    b.add_str("description", wd.description);
    b.add_float("default_damage", defDmg);
    if (!damages.empty()) {
        b.add_raw("damages", detail::FloatVector(damages));
    }
    b.add_float("reload_time", wd.reload);
    b.add_int("salvo_size", wd.salvosize);
    b.add_int("salvo_delay", wd.salvodelay);
    b.add_float("accuracy", wd.accuracy);
    b.add_float("spray_angle", wd.sprayAngle);
    b.add_float("moving_accuracy", wd.movingAccuracy);
    b.add_float("target_move_error", wd.targetMoveError);
    b.add_float("lead_limit", wd.leadLimit);
    b.add_float("edge_effectiveness", wd.damages.edgeEffectiveness);
    b.add_float("impulse_factor", wd.damages.impulseFactor);
    b.add_float("impulse_boost", wd.damages.impulseBoost);
    b.add_float("crater_mult", wd.damages.craterMult);
    b.add_float("crater_boost", wd.damages.craterBoost);
    b.add_float("crater_aoe", wd.damages.craterAreaOfEffect);
    b.add_float("fire_starter", wd.fireStarter);
    b.add_float("flight_time", wd.flighttime);
    b.add_float("weapon_acceleration", wd.weaponacceleration);
    b.add_float("turn_rate", wd.turnrate);
    b.add_float("uptime", wd.uptime);
    b.add_float("coverage_range", wd.coverageRange);
    b.add_float("stockpile_time", wd.stockpileTime);
    b.add_float("metal_cost", wd.cost.metal);
    b.add_float("energy_cost", wd.cost.energy);
    b.add_int("flags", static_cast<long long>(flags));
    if (!cps.empty()) {
        b.add_raw("custom_params", detail::StringMap(cps));
    }
    b.add_str("model_url", modelUrl);
    b.add_str("texture1", resolvedTex[0]);
    b.add_str("texture2", resolvedTex[1]);
    b.add_str("texture3", resolvedTex[2]);
    b.add_str("ceg_tag", stripCustomLower(wd.visuals.ptrailExpGenTag));
    b.add_str("explosion_generator", stripCustomLower(wd.visuals.impactExpGenTag));
    b.add_str("bounce_explosion_generator", stripCustomLower(wd.visuals.bounceExpGenTag));
    b.add_float("scroll_speed", wd.visuals.scrollspeed);

    // Weapon sounds — fireSound + hitSound [dry, wet].
    {
        uint16_t nextId = 0;
        std::string soundsArr;
        soundsArr.reserve(64);
        soundsArr += '{';
        bool firstSnd = true;
        auto pushSound = [&](const std::string& name, float volume,
                             int categoryCode) {
            if (name.empty()) return;
            if (!firstSnd) soundsArr += ',';
            firstSnd = false;
            std::string p = name;
            std::replace(p.begin(), p.end(), '\\', '/');
            std::transform(p.begin(), p.end(), p.begin(),
                [](unsigned char c){ return static_cast<char>(std::tolower(c)); });
            if (p.find("sounds/") != 0 && p.find('.') == std::string::npos) {
                p = "sounds/" + p;
            }
            const float vol = (volume > 0.0f) ? std::min(volume, 4.0f) : 1.0f;
            detail::LuaBuilder sb;
            sb.add_int("id", nextId++);
            sb.add_str("path", p);
            sb.add_str("name", name);
            sb.add_int("category", categoryCode);
            sb.add_float("volume", vol, /*def=*/1.0);
            sb.add_float("pitch", 1.0, /*def=*/1.0);
            soundsArr += sb.finish();
        };
        // SoundCategory: Fire=9, HitDry=10, HitWet=11 (from schema)
        for (size_t i = 0; i < wd.fireSound.NumSounds(); ++i) {
            const auto& d = wd.fireSound.GetSoundData(static_cast<int>(i));
            pushSound(d.name, d.volume, 9);
        }
        const int numHit = static_cast<int>(wd.hitSound.NumSounds());
        for (int i = 0; i < numHit; ++i) {
            const auto& d = wd.hitSound.GetSoundData(i);
            pushSound(d.name, d.volume, i == 0 ? 10 : 11);
        }
        soundsArr += '}';
        if (nextId > 0) {
            b.add_raw("sounds", std::move(soundsArr));
        }
    }

    return b.finish();
}

template<typename WeaponDefVec>
inline std::string SerializeWeaponDefs(
    const WeaponDefVec& defs,
    const std::string& gameId,
    const std::unordered_set<std::string>* projectileTextureNames)
{
    namespace fs = std::filesystem;
    const fs::path modelsDir = gameId.empty()
        ? fs::path{}
        : fs::path("data/games") / gameId / "models";

    std::string out;
    out.reserve(defs.size() * 512);
    out += "return{defs={";
    bool first = true;
    for (size_t i = 1; i < defs.size(); ++i) {
        if (!first) out += ',';
        first = false;
        out += SerializeOneWeaponDef(defs[i], modelsDir, gameId,
                                     projectileTextureNames);
    }
    out += "}}";
    return out;
}

} // namespace LuaDefsSerializer

#endif // LUA_DEFS_SERIALIZER_INL
