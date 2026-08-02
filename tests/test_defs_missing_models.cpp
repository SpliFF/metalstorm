/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// The missing-model diagnostic (PLAN-metalstorm-beta-units.md).
//
// A unit def whose `objectname` names a `.gltf` that is not on disk is not an
// error any layer of the pipeline reports: LuaDefsSerializer emits an empty
// `model_url`, and the client silently degrades the def to a procedural shape
// (or, for a squad def, to the proxy capsule). That silence is how a scenario
// ends up "mostly placeholders" with nothing in the logs saying so — the
// 2026-08-03 user report. FindDefsWithMissingModels is what makes it loud, so
// it is worth a test of its own.
//
// `impostor_only` defs are the deliberate exception: the billboard IS their
// model (§2.1 roster — infantry / civilians ship no 3D model at all), so a
// missing `.gltf` for them is correct and must NOT be reported.

#include <doctest/doctest.h>

#include "Server/LuaDefsSerializer.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <map>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

/// The three fields FindDefsWithMissingModels touches. Deliberately a
/// stand-in rather than the engine UnitDef — the serializer is a template
/// precisely so it can be exercised without booting the sim.
struct FakeUnitDef {
    std::string name;
    std::string modelName;
    std::map<std::string, std::string> customParams;
};

/// A temp models/ dir containing exactly the given stems as `.gltf` files.
struct ModelsDir {
    fs::path path;
    explicit ModelsDir(const std::vector<std::string>& stems) {
        path = fs::temp_directory_path() /
               ("springtest_models_" + std::to_string(
                    std::hash<const void*>{}(this)));
        fs::create_directories(path);
        for (const auto& s : stems)
            std::ofstream(path / (s + ".gltf")) << "{}";
    }
    ~ModelsDir() {
        std::error_code ec;
        fs::remove_all(path, ec);
    }
};

bool mentions(const std::vector<std::string>& rows, const std::string& defName) {
    return std::any_of(rows.begin(), rows.end(), [&](const std::string& r) {
        return r.rfind(defName + " ", 0) == 0;
    });
}

} // namespace

TEST_CASE("missing-model diagnostic names every silently-degraded def") {
    ModelsDir models({"fable_tank", "ms_radar_s1"});

    std::vector<FakeUnitDef> defs = {
        {},                                              // slot 0 sentinel
        {"ms_tanks_s2", "fable_tank", {}},               // model present
        {"ms_radar_s1", "ms_radar_s1", {}},              // model present
        {"ms_tanks_s3", "ms_tanks_s3", {}},              // MISSING
        {"ms_subs_s1",  "ms_subs_s1",  {}},              // MISSING
    };

    const auto missing =
        LuaDefsSerializer::FindDefsWithMissingModels(defs, models.path);

    CHECK(missing.size() == 2);
    CHECK(mentions(missing, "ms_tanks_s3"));
    CHECK(mentions(missing, "ms_subs_s1"));
    CHECK_FALSE(mentions(missing, "ms_tanks_s2"));
    CHECK_FALSE(mentions(missing, "ms_radar_s1"));
    // The offending objectname is in the row, so the log says what to fix.
    CHECK(missing[0].find("objectname=ms_tanks_s3") != std::string::npos);
}

TEST_CASE("impostor_only defs are not reported as missing models") {
    ModelsDir models({});   // no models at all

    std::vector<FakeUnitDef> defs = {
        {},
        {"ms_soldiers_s1", "ms_soldiers_s1", {{"impostor_only", "1"}}},
        {"ms_civilians",   "ms_civilians",   {{"impostor_only", "1"}}},
        // impostor_distance alone is a LOD hint, not "no model" — such a def
        // still wants its glTF and must still be reported.
        {"ms_mechs_s1",    "ms_mechs_s1",    {{"impostor_distance", "900"}}},
        // An explicit "0" is not an opt-in.
        {"ms_ships_s1",    "ms_ships_s1",    {{"impostor_only", "0"}}},
    };

    const auto missing =
        LuaDefsSerializer::FindDefsWithMissingModels(defs, models.path);

    CHECK(missing.size() == 2);
    CHECK(mentions(missing, "ms_mechs_s1"));
    CHECK(mentions(missing, "ms_ships_s1"));
    CHECK_FALSE(mentions(missing, "ms_soldiers_s1"));
    CHECK_FALSE(mentions(missing, "ms_civilians"));
}

TEST_CASE("a def with no objectname at all is not a missing model") {
    ModelsDir models({});
    std::vector<FakeUnitDef> defs = {
        {},
        {"ms_abstract", "", {}},
    };
    CHECK(LuaDefsSerializer::FindDefsWithMissingModels(defs, models.path).empty());
}
