/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef GEOMETRIC_OBJECTS_H
#define GEOMETRIC_OBJECTS_H

#include "System/Misc/NonCopyable.h"
#include "System/float3.h"


// Server-side stub: geometric overlays are rendering-only; all methods are no-ops.
class CGeometricObjects : public spring::noncopyable
{
public:
	CGeometricObjects() {}
	~CGeometricObjects() {}

	int  AddSpline(float3 b1, float3 b2, float3 b3, float3 b4, float width, int arrow, int lifeTime = -1, int group = 0) { return 0; }
	void DeleteGroup(int group) {}
	void SetColor(int group, float r, float g, float b, float a) {}
	float3 CalcSpline(float i, const float3& p1, const float3& p2, const float3& p3, const float3& p4) { return float3(); }
	int  AddLine(float3 start, float3 end, float width, int arrow, int lifetime = -1, int group = 0) { return 0; }
	void Update() {}
	void MarkSquare(int mapSquare) {}
};

extern CGeometricObjects* geometricObjects;

#endif /* GEOMETRIC_OBJECTS_H */
