/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/* Minimal model stubs for the server build.
 *
 * The full rendering-side types live in Rendering/Models/3DModel.h
 * which is deleted on the server. The sim only needs what the
 * synced simulation reads at runtime: bounding sphere, height,
 * mid-position, per-piece offsets and the piece tree topology for
 * script animation and local coordinate transforms.
 *
 * These are populated from a preprocessed `<model>.config.json`
 * (or hand-authored `<model>.config.lua`) file written by the
 * modelimporter tool at content-preprocess time — see
 * tools/modelimporter/JsonWriter.cpp for the emitter and
 * rts/Sim/Objects/ModelConfigLoader.cpp for the reader, which
 * dispatches between the two forms via LuaConfig::Load.
 */

#ifndef LOCAL_MODEL_PIECE_STUB_H
#define LOCAL_MODEL_PIECE_STUB_H

#include "System/float3.h"
#include "System/Matrix44f.h"
#include "Sim/Misc/CollisionVolume.h"
#include <vector>
#include <string>

/* Minimal S3DModelPiece stub — only fields the server sim references. */
struct S3DModelPiece {
	/// Translation from this piece's parent origin, in model space.
	float3 offset;

	/// Axis-aligned bounds of the piece's own geometry in its local
	/// coordinate frame (does not include descendant pieces).
	float3 mins;
	float3 maxs;

	/// Piece name as extracted from the source model. Used by unit
	/// scripts to look up pieces by name and by the attachment-
	/// point scanner in ModelConfigLoader.
	std::string name;

	/// Parent / children links form the piece tree. `parent`
	/// is nullptr for the root piece.
	S3DModelPiece* parent = nullptr;
	std::vector<S3DModelPiece*> children;

	bool HasGeometryData() const {
		return (maxs.x > mins.x) || (maxs.y > mins.y) || (maxs.z > mins.z);
	}
	void Shatter(const void*, int, float, const float3&, const float3&, const CMatrix44f&) const {}
};

/* Minimal S3DModel stub — only fields the server sim references. */
struct S3DModel {
	/// Bounding sphere radius around the model origin.
	float radius = 1.0f;
	/// Total Y extent of the model in its own space.
	float height = 1.0f;
	/// Axis-aligned bounds in model space.
	float3 mins;
	float3 maxs;
	/// Mid-position (center of mass / aim target), in model space.
	float3 relMidPos;

	/// Flat piece list in pre-order (root first, then each piece's
	/// subtree before the next sibling). `numPieces` mirrors
	/// `pieces.size()` for upstream-compat callers.
	std::vector<S3DModelPiece> pieces;
	int numPieces = 0;

	/// Absolute on-disk base path (no suffix) of the config file
	/// the model was populated from. Useful for diagnostics and
	/// for reloading at dev time if the file changes. Empty if
	/// the model was default-initialised without a config file.
	std::string metaPath;

	/// Model name (e.g. "arm_flash")
	std::string name;
};

struct LocalModelPiece {
	float3 GetPosition() const { return pos; }
	float3 GetRotation() const { return rot; }
	void   SetPosition(const float3& p) { pos = p; dirty = true; }
	void   SetRotation(const float3& r) { rot = r; dirty = true; }

	float3 GetAbsolutePos() const { return pos; }
	CMatrix44f GetModelSpaceMatrix() const { return CMatrix44f(); }
	// Headless stub: there's no model geometry, so the "emit dir/pos"
	// is just the piece's local-space position with a default up-vector.
	// Returning true (success) keeps EmitSfx and weapon muzzle queries
	// from spamming "[US::EmitSFX] invalid model piece index" errors —
	// SFX has no server-side meaning, and the weapon hit code falls
	// back gracefully when the muzzle ends up at the unit centre.
	bool GetEmitDirPos(float3& outPos, float3& outDir) const { outPos = pos; outDir = float3(0.0f, 1.0f, 0.0f); return true; }

	const CollisionVolume* GetCollisionVolume() const { return &colvol; }
	      CollisionVolume* GetCollisionVolume()       { return &colvol; }

	float3 GetDirection() const { return float3(0.0f, 0.0f, 1.0f); }

	int  GetLModelPieceIndex() const { return lmodelPieceIndex; }
	int  GetScriptPieceIndex() const { return scriptPieceIndex; }
	void SetScriptPieceIndex(int i)  { scriptPieceIndex = i; }

	bool visible         = true;
	bool dirty           = false;
	void SetScriptVisible(bool b) { scriptSetVisible = b; }
	bool scriptSetVisible = true;

	int lmodelPieceIndex = -1;
	int scriptPieceIndex = -1;

	const S3DModelPiece* original = nullptr;

private:
	float3 pos;
	float3 rot;
	CollisionVolume colvol;
};

struct LocalModel {
	bool Initialized()     const { return !pieces.empty(); }
	bool HasPiece(int n)   const { return (n >= 0 && n < static_cast<int>(pieces.size())); }

	const LocalModelPiece* GetPiece(int n) const { return HasPiece(n) ? &pieces[n] : nullptr; }
	      LocalModelPiece* GetPiece(int n)       { return HasPiece(n) ? &pieces[n] : nullptr; }

	const CollisionVolume* GetBoundingVolume() const { return &boundingVolume; }

	float3 GetRawPiecePos(int n) const { return HasPiece(n) ? pieces[n].GetPosition() : float3(); }

	/// Populate LocalModel piece table from a loaded S3DModel.
	/// Copies piece count + name/offset from the template so script
	/// code can look up pieces by index. Rendering (which uses the
	/// full local-space transform stack) happens on the client.
	void SetModel(const S3DModel* mdl, bool /*initialize*/ = true) {
		if (mdl == nullptr) return;
		pieces.resize(mdl->pieces.size());
		for (size_t i = 0; i < pieces.size(); ++i) {
			pieces[i].lmodelPieceIndex = static_cast<int>(i);
			pieces[i].original         = &mdl->pieces[i];
			pieces[i].SetPosition(mdl->pieces[i].offset);
		}
	}

	std::vector<LocalModelPiece> pieces;
	CollisionVolume boundingVolume;
};

#endif // LOCAL_MODEL_PIECE_STUB_H
