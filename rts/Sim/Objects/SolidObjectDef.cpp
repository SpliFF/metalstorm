/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "SolidObjectDef.h"
#include "ModelConfigLoader.h"
#include "Lua/LuaConfigLoader.h"
#include "Lua/LuaParser.h"
#include "Sim/Misc/CollisionVolume.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"
#include "System/EventHandler.h"
#include "System/FileSystem/FileHandler.h"
#include "System/Log/ILog.h"

#include <cstdio>
#include <filesystem>

SolidObjectDecalDef::SolidObjectDecalDef()
	: useGroundDecal(false)
	, groundDecalType(-1)
	, groundDecalSizeX(-1)
	, groundDecalSizeY(-1)
	, groundDecalDecaySpeed(0.0f)

	, leaveTrackDecals(false)
	, trackDecalType(-1)
	, trackDecalWidth(0.0f)
	, trackDecalOffset(0.0f)
	, trackDecalStrength(0.0f)
	, trackDecalStretch(0.0f)
{}

void SolidObjectDecalDef::Parse(const LuaTable& table) {
	groundDecalTypeName = table.GetString("groundDecalType", table.GetString("buildingGroundDecalType", ""));
	trackDecalTypeName = table.GetString("trackType", "StdTank");

	useGroundDecal        = table.GetBool("useGroundDecal", table.GetBool("useBuildingGroundDecal", false));
	groundDecalType       = -1;
	groundDecalSizeX      = table.GetInt("groundDecalSizeX", table.GetInt("buildingGroundDecalSizeX", 4));
	groundDecalSizeY      = table.GetInt("groundDecalSizeY", table.GetInt("buildingGroundDecalSizeY", 4));
	groundDecalDecaySpeed = table.GetFloat("groundDecalDecaySpeed", table.GetFloat("buildingGroundDecalDecaySpeed", 0.1f));

	leaveTrackDecals   = table.GetBool("leaveTracks", false);
	trackDecalType     = -1;
	trackDecalWidth    = table.GetFloat("trackWidth",   32.0f);
	trackDecalOffset   = table.GetFloat("trackOffset",   0.0f);
	trackDecalStrength = table.GetFloat("trackStrength", 0.0f);
	trackDecalStretch  = table.GetFloat("trackStretch",  1.0f);
}

SolidObjectDef::SolidObjectDef()
	: id(-1)

	, xsize(0)
	, zsize(0)

	, metal(0.0f)
	, energy(0.0f)
	, health(0.0f)
	, mass(0.0f)
	, crushResistance(0.0f)

	, collidable(false)
	, selectable(true)
	, upright(false)
	, reclaimable(true)

	, model(nullptr)
{
}


void SolidObjectDef::ParseCollisionVolume(const LuaTable& odTable)
{
	const LuaTable& cvTable = odTable.SubTable("collisionVolume");
	const std::string& cvType = odTable.GetString("collisionVolumeType", "");

	if (cvTable.IsValid()) {
		collisionVolume = CollisionVolume(
			cvTable.GetInt("type", 's'),
			cvTable.GetInt("axis", 'z'),
			cvTable.GetFloat3("scales" , ZeroVector),
			cvTable.GetFloat3("offsets", ZeroVector)
		);
	} else {
		collisionVolume = CollisionVolume(
			((cvType.empty())? 's': cvType.front()),
			((cvType.empty())? 'z': cvType.back ()),
			odTable.GetFloat3("collisionVolumeScales" , ZeroVector),
			odTable.GetFloat3("collisionVolumeOffsets", ZeroVector)
		);
	}

	// if this unit wants per-piece volumes, make
	// its main collision volume deferent and let
	// it ignore hits
	collisionVolume.SetDefaultToPieceTree(odTable.GetBool("usePieceCollisionVolumes", false));
	collisionVolume.SetDefaultToFootPrint(odTable.GetBool("useFootPrintCollisionVolume", false));
	collisionVolume.SetIgnoreHits(collisionVolume.DefaultToPieceTree());
}

void SolidObjectDef::ParseSelectionVolume(const LuaTable& odTable)
{
	const LuaTable& svTable = odTable.SubTable("selectionVolume");
	const std::string& svType = odTable.GetString("selectionVolumeType", odTable.GetString("collisionVolumeType", ""));

	if (svTable.IsValid()) {
		selectionVolume = CollisionVolume(
			svTable.GetInt("type", 's'),
			svTable.GetInt("axis", 'z'),
			svTable.GetFloat3("scales" , ZeroVector),
			svTable.GetFloat3("offsets", ZeroVector)
		);
	} else {
		selectionVolume = CollisionVolume(
			((svType.empty())? 's': svType.front()),
			((svType.empty())? 'z': svType.back ()),
			odTable.GetFloat3("selectionVolumeScales" , odTable.GetFloat3("collisionVolumeScales" , ZeroVector)),
			odTable.GetFloat3("selectionVolumeOffsets", odTable.GetFloat3("collisionVolumeOffsets", ZeroVector))
		);
	}

	selectionVolume.SetDefaultToPieceTree(odTable.GetBool("usePieceSelectionVolumes", false));
	selectionVolume.SetDefaultToFootPrint(odTable.GetBool("useFootPrintSelectionVolume", false));
	selectionVolume.SetIgnoreHits(selectionVolume.DefaultToPieceTree());
}


// Server-side model loading: we don't parse the binary mesh.
// The modelimporter tool has already run at content-preprocess
// time and emitted a `<stem>.config.json` (or an author-supplied
// `<stem>.config.lua`) next to the converted `.glb`. The sim
// reads that config via ModelConfigLoader + LuaConfig and
// populates an S3DModel stub with the fields it actually needs
// (bounding sphere, height, piece tree, mid-position).
//
// Search order:
//   1. `<stem>.config.lua` in any content root — author-owned
//      Lua form wins if present.
//   2. `<stem>.config.json` in any content root — the form
//      modelimporter writes by default.
//
// Both `data/maps/<mapId>/features/` and `data/games/<gameId>/
// models/` are added as content roots at game-start, so a bare-
// name lookup finds whichever form exists. If nothing is found
// we fall through to a default-initialised S3DModel — the unit
// still spawns and collides using its unitdef-declared
// collisionVolume fields, just with radius=1.

namespace {

/// Build a base path (no .config.lua / .config.json suffix) from
/// a `modelName` that may be either `GreyRock1.s3o` or a bare
/// `pt_lighttank`. The content root subdir prefix is passed in
/// separately so callers can probe multiple directories.
std::string BasePathFor(const std::string& subdir, const std::string& modelName) {
    namespace fs = std::filesystem;
    fs::path p(modelName);
    // .stem() drops the last extension if any.
    return subdir + p.stem().string();
}

/// Probe a content root for either `<base>.config.lua` or
/// `<base>.config.json`. Returns the absolute base path (without
/// suffix) of the first hit, or empty string if neither form is
/// present under that relative subdir.
std::string ResolveConfigBase(const std::string& relBase) {
    const std::string lua  = relBase + LuaConfig::kLuaSuffix;
    const std::string json = relBase + LuaConfig::kJsonSuffix;
    if (CFileHandler::FileExists(lua)) {
        const std::string abs = CFileHandler::GetFileAbsolutePath(lua);
        // Strip the suffix we appended so ModelConfigLoader::LoadInto
        // gets the base path and re-resolves Lua-vs-JSON internally.
        return abs.substr(0, abs.size() - std::string(LuaConfig::kLuaSuffix).size());
    }
    if (CFileHandler::FileExists(json)) {
        const std::string abs = CFileHandler::GetFileAbsolutePath(json);
        return abs.substr(0, abs.size() - std::string(LuaConfig::kJsonSuffix).size());
    }
    return {};
}

/// Lazy-load + cache the config-backed model for a def. First
/// call populates `cached`; subsequent calls return it.
S3DModel* EnsureLoaded(S3DModel*& cached, const std::string& modelName) {
    if (cached != nullptr)
        return cached;

    cached = new S3DModel(); // default-initialised fallback

    if (modelName.empty())
        return cached;

    // Candidate search paths, in precedence order. modelimporter
    // writes into `objects3d/` next to the source file and into the
    // preprocessed `features/` / `models/` dirs for auto-converted
    // assets; all three are typically content roots by the time
    // LoadDefs runs.
    const std::string subdirs[] = {
        "objects3d/",
        "features/",
        "",                // bare lookup via all content roots
    };

    for (const auto& subdir : subdirs) {
        const std::string relBase = BasePathFor(subdir, modelName);
        const std::string absBase = ResolveConfigBase(relBase);
        if (absBase.empty()) continue;
        if (ModelConfigLoader::LoadInto(*cached, absBase)) {
            return cached;
        }
    }

    std::fprintf(stderr,
        "[model] %s: no .config.lua/.config.json found under content "
        "roots. Spawning with default bounds radius=1 height=1 — "
        "gadgets that read Spring.GetUnitRadius may see unexpected "
        "values.\n",
        modelName.c_str());
    return cached;
}

} // namespace

S3DModel* SolidObjectDef::LoadModel() const {
    return EnsureLoaded(model, modelName);
}

void SolidObjectDef::PreloadModel() const {
    (void)EnsureLoaded(model, modelName);
}

float SolidObjectDef::GetModelRadius() const {
    return (model != nullptr) ? model->radius : 1.0f;
}

