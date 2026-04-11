/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "SolidObjectDef.h"
#include "MetaLuaModelLoader.h"
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
// time and emitted a `<name>.meta.lua` next to the converted
// `.glb`. The sim reads that Lua table via MetaLuaModelLoader
// and populates an S3DModel stub with the fields it actually
// needs (bounding sphere, height, piece tree, mid-position).
//
// Search order for the `.meta.lua`:
//   1. `<modelName stem>.meta.lua` in any content root (the
//      game's objects3d/ and a future per-game `data/games/<id>/
//      models/` both land here via CFileHandler content roots).
//   2. `data/maps/<mapId>/features/<stem>.meta.lua` — the path
//      FeatureProcessor writes to. The map dir is added as a
//      content root at game-start, so step 1 already covers this.
//
// If nothing is found, we fall through to a default-initialised
// S3DModel — the unit still spawns and collides using its
// unitdef-declared collisionVolume fields, just with radius=1.

namespace {

/// Build a `.meta.lua` filename from a model name. Accepts both
/// `GreyRock1.s3o` (strip extension) and bare `pt_lighttank`
/// (no extension to begin with).
std::string MetaFilenameFor(const std::string& modelName) {
    namespace fs = std::filesystem;
    fs::path p = modelName;
    // .stem() drops the last extension if any; .filename() keeps
    // it. We want the stem + ".meta.lua".
    return p.stem().string() + ".meta.lua";
}

/// Resolve a filename through the content-root search path.
/// Returns the absolute path of the first hit, or empty string.
std::string ResolveContentPath(const std::string& rel) {
    if (CFileHandler::FileExists(rel)) {
        return CFileHandler::GetFileAbsolutePath(rel);
    }
    return {};
}

/// Lazy-load + cache the meta.lua-backed model for a def.
/// First call populates `out`; subsequent calls return it.
S3DModel* EnsureLoaded(S3DModel*& cached, const std::string& modelName) {
    if (cached != nullptr)
        return cached;

    cached = new S3DModel(); // default-initialised fallback

    if (modelName.empty())
        return cached;

    const std::string metaName = MetaFilenameFor(modelName);

    // Candidate search paths, in precedence order. modelimporter
    // writes into `objects3d/` next to the source file for
    // authored overrides and into the preprocessed features/ dir
    // for auto-converted assets. Both directories are typically
    // content roots by the time LoadDefs runs.
    const std::string candidates[] = {
        "objects3d/" + metaName,
        "features/"  + metaName,
        metaName,                    // bare lookup via all content roots
    };

    for (const auto& rel : candidates) {
        const std::string abs = ResolveContentPath(rel);
        if (abs.empty()) continue;
        if (MetaLuaModelLoader::LoadInto(*cached, abs)) {
            return cached;
        }
    }

    std::fprintf(stderr,
        "[model] %s: no .meta.lua found (looked for %s under content "
        "roots). Spawning with default bounds radius=1 height=1 — "
        "gadgets that read Spring.GetUnitRadius may see unexpected "
        "values.\n",
        modelName.c_str(), metaName.c_str());
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

