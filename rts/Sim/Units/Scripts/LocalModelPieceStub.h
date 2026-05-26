/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/* Minimal model stubs for the server build.
 *
 * The full rendering-side types live in Rendering/Models/3DModel.h
 * which is deleted on the server. The sim only needs what the
 * synced simulation reads at runtime: bounding sphere, height,
 * mid-position, per-piece offsets and the piece tree topology for
 * script animation and local coordinate transforms.
 *
 * These are populated from a `SPRINGRTS_geometry` document-level
 * extension embedded in the `<model>.gltf` written by modelimporter
 * at content-preprocess time. Hand-authored `<model>.config.lua`
 * files act as optional per-field overrides. See
 * tools/modelimporter/GeometryExtractor.cpp for the emitter and
 * rts/Sim/Objects/ModelConfigLoader.cpp for the reader.
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

	/// Position of this piece in the model's coordinate frame, with
	/// every ancestor's translation+rotation applied. Used by
	/// `Spring.GetUnitPiecePos*` and by `CWeapon::UpdateWeaponVectors`
	/// to compute the muzzle origin in unit-object space (which then
	/// becomes the projectile spawn point in world space).
	///
	/// Without parent-chain traversal the headless server reports
	/// every piece at its parent-local offset, which puts weapons at
	/// the unit centre instead of the barrel tip and results in
	/// projectiles spawning inside the firing unit's collision sphere.
	float3 GetAbsolutePos() const { return GetModelSpaceMatrix().GetPos(); }

	/// Compose this piece's transform matrix walking up the parent
	/// chain. Each level is `T(pos) * RotateEulerYXZ(rot)`.
	///
	/// Spring's LH-canonical `RotateY(+a)` is numerically equivalent to
	/// the right-handed `RotY(-a)`. In our RH world (post-Phase-2 basis
	/// flip) the script convention `Turn(y_axis, +a) = turn right` maps
	/// to RH RotY(-a) — exactly what the LH primitive produces when fed
	/// +a. The same holds for X (pitch down) and Z (roll right). No
	/// per-axis sign juggling is required: the LH primitive applied to
	/// the raw script angle yields the correct RH matrix for the script's
	/// intent, and the client mirrors this with Babylon's true-RH primitive
	/// fed -rot.x / -rot.y / -rot.z in springToBabylonLocal.
	///
	/// Phase 2a originally negated Z only (`R(rot.x, rot.y, -rot.z)`) on
	/// the theory that handedness flip "compensates" X/Y but not Z. The
	/// piece-transform tests caught the resulting sign error — legs swung
	/// up instead of down, turrets aimed mirrored. Reverting to the
	/// uniform `R(rot)` form fixes both.
	CMatrix44f GetModelSpaceMatrix() const {
		CMatrix44f local;
		local.Translate(pos);
		// Skip the no-op work when the piece hasn't been rotated.
		// Almost every static decorative piece on a unit stays at
		// rest, so this saves three trig calls per piece per frame.
		if (rot.x != 0.0f || rot.y != 0.0f || rot.z != 0.0f)
			local.RotateEulerYXZ(rot);
		if (parent != nullptr)
			return parent->GetModelSpaceMatrix() * local;
		return local;
	}

	/// `outPos` is the piece origin in model space; `outDir` is the
	/// piece's local -Z (glTF-native forward / RH emit-axis) rotated
	/// by the piece's accumulated transform — i.e. where a weapon's
	/// muzzle is pointing in world-relative terms.
	///
	/// PLAN-coordinate-system Phase 2: the emit axis flipped from
	/// local +Z (Spring's LH convention) to local -Z to match the
	/// glTF-native forward direction.
	bool GetEmitDirPos(float3& outPos, float3& outDir) const {
		const CMatrix44f mat = GetModelSpaceMatrix();
		outPos = mat.GetPos();
		// Multiply the local -Z basis vector through the rotation
		// (treating it as a vector, not a point — subtract the
		// translation back out). `mat * float3` is a point transform
		// with implicit w=1.
		outDir = (mat * float3(0.0f, 0.0f, -1.0f)) - outPos;
		return true;
	}

	const CollisionVolume* GetCollisionVolume() const { return &colvol; }
	      CollisionVolume* GetCollisionVolume()       { return &colvol; }

	/// Forward direction (local -Z, RH) of the piece in model space.
	/// Used by a handful of unit-script utility callouts; matches
	/// the dir component of GetEmitDirPos.
	float3 GetDirection() const {
		const CMatrix44f mat = GetModelSpaceMatrix();
		const float3 origin = mat.GetPos();
		return ((mat * float3(0.0f, 0.0f, -1.0f)) - origin).SafeNormalize();
	}

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
	/// Pointer to the parent piece in the LocalModel array. Wired up
	/// in `LocalModel::SetModel`. Null for the root piece.
	LocalModelPiece* parent = nullptr;

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
			pieces[i].parent           = nullptr;
		}
		// Second pass: link each piece's parent. The S3DModelPiece
		// template carries a `parent` pointer that points into the
		// model's own piece array; we map that to our LocalModelPiece
		// instance by matching the `original` back-pointer. Done as
		// a separate pass because the template parents may not have
		// been constructed yet during the first pass on some compilers.
		for (size_t i = 0; i < pieces.size(); ++i) {
			const S3DModelPiece* tplParent = mdl->pieces[i].parent;
			if (tplParent == nullptr) continue;
			for (size_t j = 0; j < pieces.size(); ++j) {
				if (pieces[j].original == tplParent) {
					pieces[i].parent = &pieces[j];
					break;
				}
			}
		}
	}

	std::vector<LocalModelPiece> pieces;
	CollisionVolume boundingVolume;
};

#endif // LOCAL_MODEL_PIECE_STUB_H
