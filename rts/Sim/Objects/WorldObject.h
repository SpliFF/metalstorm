/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef WORLD_OBJECT_H
#define WORLD_OBJECT_H

#include "System/Object.h"
#include "System/float4.h"
#include "System/Threading/ThreadPool.h"
#include "Sim/Units/Scripts/LocalModelPieceStub.h"

#include <array>

enum DrawFlags : uint8_t {
	SO_NODRAW_FLAG = 0,
	SO_OPAQUE_FLAG = 1,
	SO_ALPHAF_FLAG = 2,
	SO_REFLEC_FLAG = 4,
	SO_REFRAC_FLAG = 8,
	SO_SHOPAQ_FLAG = 16,
	SO_SHTRAN_FLAG = 32,
	SO_DRICON_FLAG = 128,
};

class CWorldObject: public CObject
{
public:
	CR_DECLARE_DERIVED(CWorldObject)

	CWorldObject() = default;
	CWorldObject(const float3& pos, const float3& spd): CWorldObject()
	{
		SetPosition(pos);
		SetVelocity(spd);
	}

	virtual ~CWorldObject() {}

	// NOTE: used only by projectiles, SolidObject's override this!
	virtual float GetDrawRadius() const { return drawRadius; }

	virtual void SetPosition(const float3& p) {   pos = p; }
	virtual void SetVelocity(const float3& v) { speed = v; }

	virtual void SetVelocityAndSpeed(const float3& v) {
		// set velocity first; do not assume f4::op=(f3) will not touch .w
		SetVelocity(v);
		SetSpeed(v);
	}

	// by default, SetVelocity does not set magnitude (for efficiency)
	// so SetSpeed must be explicitly called to update the w-component
	float SetSpeed(const float3& v) { return (speed.w = v.Length()); }

	void SetRadiusAndHeight(float r, float h) {
		radius = r;
		height = h;
		sqRadius = r * r;
		drawRadius = r;
	}
	void SetRadiusAndHeight(const S3DModel* mdl) {
		if (mdl == nullptr) return;
		radius = mdl->radius;
		height = mdl->height;
		sqRadius = mdl->radius * mdl->radius;
		drawRadius = mdl->radius;
	}

	// extrapolated base-positions; used in unsynced code
	float3 GetDrawPos(                float t) const { return (pos + speed * t); }
	float3 GetDrawPos(const float3 v, float t) const { return (pos +     v * t); }

public:
	int id = -1;
	int tempNum = 0;            ///< used to check if object has already been processed (in QuadField queries, etc)
	std::array<int, ThreadPool::MAX_THREADS> mtTempNum = {}; ///< thread-safe version of tempNum

	float3 pos;                 ///< position of the very bottom of the object
	float4 speed;               ///< current velocity vector (elmos/frame), .w = |velocity|

	float radius = 0.0f;        ///< used for collisions
	float height = 0.0f;        ///< The height of this object
	float sqRadius = 0.0f;
	float drawRadius = 0.0f;    ///< unsynced, used for projectile visibility culling
	float buildeeRadius = 0.0f; ///< used for build, repair, reclaim, capture, resurrect

	bool useAirLos = false;     ///< if true, the object's visibility is checked against airLosMap[allyteam]
	bool alwaysVisible = false; ///< if true, object is drawn even if not in LOS

	void ResetDrawFlag() { drawFlag = DrawFlags::SO_NODRAW_FLAG; }
	void SetDrawFlag(DrawFlags f) { drawFlag  =  f; }
	void AddDrawFlag(DrawFlags f) { drawFlag |=  f; }
	void DelDrawFlag(DrawFlags f) { drawFlag &= ~f; }
	bool HasDrawFlag(DrawFlags f) const { return (drawFlag & f) == f; }
	DrawFlags GetDrawFlag() const { return static_cast<DrawFlags>(drawFlag); }

	uint8_t drawFlag = DrawFlags::SO_NODRAW_FLAG;
	uint8_t previousDrawFlag = DrawFlags::SO_NODRAW_FLAG;
};

#endif /* WORLD_OBJECT_H */
