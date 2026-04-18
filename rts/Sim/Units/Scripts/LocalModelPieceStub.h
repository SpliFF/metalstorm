/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/* Minimal model stubs for the server build.
 * The full rendering-side types live in Rendering/Models/3DModel.h which is
 * deleted on the server. The sim only needs piece transform storage to drive
 * COB/Lua script animation; rendering picks those up via the network.
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
	float3 offset;
	float3 mins;
	float3 maxs;
	std::string name;

	S3DModelPiece* parent = nullptr;
	std::vector<S3DModelPiece*> children;

	bool HasGeometryData() const { return false; }
	void Shatter(const void*, int, float, const float3&, const float3&, const CMatrix44f&) const {}
};

/* Minimal S3DModel stub — only fields the server sim references. */
struct S3DModel {
	float radius   = 1.0f;
	float height   = 1.0f;
	float3 relMidPos;
	float3 mins;
	float3 maxs;
	int numPieces  = 0;
};

struct LocalModelPiece {
	float3 GetPosition() const { return pos; }
	float3 GetRotation() const { return rot; }
	void   SetPosition(const float3& p) { pos = p; dirty = true; }
	void   SetRotation(const float3& r) { rot = r; dirty = true; }

	float3 GetAbsolutePos() const { return pos; }
	CMatrix44f GetModelSpaceMatrix() const { return CMatrix44f(); }
	bool GetEmitDirPos(float3& outPos, float3& outDir) const { outPos = pos; outDir = float3(0.0f, 1.0f, 0.0f); return false; }

	const CollisionVolume* GetCollisionVolume() const { return &colvol; }
	      CollisionVolume* GetCollisionVolume()       { return &colvol; }

	float3 GetDirection() const { return float3(0.0f, 0.0f, 1.0f); }

	int  GetLModelPieceIndex() const { return lmodelPieceIndex; }
	int  GetScriptPieceIndex() const { return scriptPieceIndex; }
	void SetScriptPieceIndex(int i)  { scriptPieceIndex = i; }

	bool visible         = true;
	bool dirty           = false;
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

	// Server stub: populate pieces from model piece count so script indices work.
	void SetModel(const S3DModel* mdl, bool /*initialize*/ = true) {
		if (mdl == nullptr) return;
		pieces.resize(mdl->numPieces);
		for (int i = 0; i < static_cast<int>(pieces.size()); ++i)
			pieces[i].lmodelPieceIndex = i;
	}

	std::vector<LocalModelPiece> pieces;
	CollisionVolume boundingVolume;
};

#endif // LOCAL_MODEL_PIECE_STUB_H
