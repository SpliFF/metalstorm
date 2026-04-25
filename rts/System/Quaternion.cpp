/* This file is part of the Recoil engine (GPL v2 or later), see LICENSE.html */

#include "System/Quaternion.h"
#include "System/SpringMath.h"
#include "System/MathConstants.h"
#include "System/Misc/TracyDefs.h"

#include <cassert>
#include <cmath>
#include <algorithm>
#include <limits>

CR_BIND(CQuaternion, )
CR_REG_METADATA(CQuaternion, (CR_MEMBER(x), CR_MEMBER(y), CR_MEMBER(z), CR_MEMBER(r)))


// ---------------------------------------------------------------------------
// Euler angle constructors
// ---------------------------------------------------------------------------

// PYR = Pitch/Yaw/Roll = XYZ order — equivalent to CMatrix44f::RotateEulerXYZ
CQuaternion CQuaternion::FromEulerPYR(const float3& angles)
{
	RECOIL_DETAILED_TRACY_ZONE;
	// Build q = Rx(p) * Ry(y) * Rz(r)  (apply X first, then Y, then Z)
	const float hp = angles.x * 0.5f;
	const float hy = angles.y * 0.5f;
	const float hr = angles.z * 0.5f;

	const float cp = std::cos(hp), sp = std::sin(hp);
	const float cy = std::cos(hy), sy = std::sin(hy);
	const float cr = std::cos(hr), sr = std::sin(hr);

	// Derived by expanding Rx * Ry * Rz
	return CQuaternion(
		sp * cy * cr + cp * sy * sr,   // x (pitch component)
		cp * sy * cr - sp * cy * sr,   // y (yaw component)
		cp * cy * sr + sp * sy * cr,   // z (roll component)
		cp * cy * cr - sp * sy * sr    // r (real)
	);
}

// YPR = Yaw/Pitch/Roll = YXZ order — equivalent to CMatrix44f::RotateEulerYXZ
CQuaternion CQuaternion::FromEulerYPR(const float3& angles)
{
	RECOIL_DETAILED_TRACY_ZONE;
	// Build q = Ry(y) * Rx(p) * Rz(r)  (apply Y first, then X, then Z)
	const float hp = angles.x * 0.5f;
	const float hy = angles.y * 0.5f;
	const float hr = angles.z * 0.5f;

	const float cp = std::cos(hp), sp = std::sin(hp);
	const float cy = std::cos(hy), sy = std::sin(hy);
	const float cr = std::cos(hr), sr = std::sin(hr);

	// Derived by expanding Ry * Rx * Rz
	return CQuaternion(
		cy * sp * cr + sy * cp * sr,   // x
		sy * cp * cr - cy * sp * sr,   // y
		cy * cp * sr - sy * sp * cr,   // z
		cy * cp * cr + sy * sp * sr    // r
	);
}


// ---------------------------------------------------------------------------
// Euler angle extractors
// ---------------------------------------------------------------------------

// Extract YXZ Euler angles (stored as pitch, yaw, roll in float3 x, y, z)
float3 CQuaternion::ToEulerYPR() const
{
	RECOIL_DETAILED_TRACY_ZONE;
	// From a quaternion representing Ry*Rx*Rz composition.
	const float sinPitch = 2.0f * (r * x - y * z);
	float pitch, yaw, roll;

	if (std::fabs(sinPitch) >= 1.0f - std::numeric_limits<float>::epsilon()) {
		// Gimbal lock
		pitch = std::copysign(math::HALFPI, sinPitch);
		yaw   = 0.0f;
		roll  = std::atan2(2.0f * (x * z - r * y), 1.0f - 2.0f * (x * x + y * y));
	} else {
		pitch = std::asin(sinPitch);
		yaw   = std::atan2(2.0f * (r * y + x * z), 1.0f - 2.0f * (x * x + y * y));
		roll  = std::atan2(2.0f * (r * z + x * y), 1.0f - 2.0f * (x * x + z * z));
	}

	return float3(pitch, yaw, roll);
}

// Extract XYZ Euler angles (stored as pitch, yaw, roll in float3 x, y, z)
float3 CQuaternion::ToEulerPYR() const
{
	RECOIL_DETAILED_TRACY_ZONE;
	// From a quaternion representing Rx*Ry*Rz composition.
	const float sinYaw = 2.0f * (r * y - z * x);
	float pitch, yaw, roll;

	if (std::fabs(sinYaw) >= 1.0f - std::numeric_limits<float>::epsilon()) {
		// Gimbal lock
		yaw   = std::copysign(math::HALFPI, sinYaw);
		pitch = std::atan2(2.0f * (r * x - y * z), 1.0f - 2.0f * (x * x + z * z));
		roll  = 0.0f;
	} else {
		yaw   = std::asin(sinYaw);
		pitch = std::atan2(2.0f * (r * x + y * z), 1.0f - 2.0f * (x * x + y * y));
		roll  = std::atan2(2.0f * (r * z + x * y), 1.0f - 2.0f * (y * y + z * z));
	}

	return float3(pitch, yaw, roll);
}


// ---------------------------------------------------------------------------
// MakeFrom factory methods
// ---------------------------------------------------------------------------

// Rotation of `angle` radians around `axis` (axis must be normalized)
CQuaternion CQuaternion::MakeFrom(float angle, const float3& axis)
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float halfAngle = angle * 0.5f;
	const float s = std::sin(halfAngle);
	return CQuaternion(axis.x * s, axis.y * s, axis.z * s, std::cos(halfAngle));
}

// Shortest rotation that takes v1 to v2 (both should be normalized)
CQuaternion CQuaternion::MakeFrom(const float3& v1, const float3& v2)
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float dot = v1.dot(v2);

	// Vectors are parallel (same direction) — return identity
	if (dot >= 1.0f - std::numeric_limits<float>::epsilon())
		return CQuaternion();

	// Vectors are anti-parallel — 180 degree rotation around any perpendicular axis
	if (dot <= -1.0f + std::numeric_limits<float>::epsilon()) {
		float3 perp = v1.PickNonParallel();
		perp = v1.cross(perp);
		perp.Normalize();
		return CQuaternion(perp.x, perp.y, perp.z, 0.0f);
	}

	// General case: use half-angle trick
	// q = (v1 x v2,  1 + dot)  then normalize
	const float3 cross = v1.cross(v2);
	CQuaternion q(cross.x, cross.y, cross.z, 1.0f + dot);
	return q.Normalize();
}

// Rotation from world forward direction (+Z) to newFwdDir
CQuaternion CQuaternion::MakeFrom(const float3& newFwdDir)
{
	RECOIL_DETAILED_TRACY_ZONE;
	static const float3 worldFwd(0.0f, 0.0f, 1.0f);
	return MakeFrom(worldFwd, newFwdDir);
}

// Extract rotation quaternion from the upper-left 3x3 of a column-major matrix
CQuaternion CQuaternion::MakeFrom(const CMatrix44f& mat)
{
	RECOIL_DETAILED_TRACY_ZONE;
	// Shepperd's method (numerically stable)
	// Column-major layout: m[col*4 + row]
	//   m[0]=m00, m[1]=m10, m[2]=m20   (col 0)
	//   m[4]=m01, m[5]=m11, m[6]=m21   (col 1)
	//   m[8]=m02, m[9]=m12, m[10]=m22  (col 2)
	const float m00 = mat.m[0];
	const float m11 = mat.m[5];
	const float m22 = mat.m[10];
	const float trace = m00 + m11 + m22;

	CQuaternion q;
	if (trace > 0.0f) {
		const float s = 0.5f / std::sqrt(trace + 1.0f);
		q.r = 0.25f / s;
		q.x = (mat.m[6] - mat.m[9]) * s;   // (m21 - m12)
		q.y = (mat.m[8] - mat.m[2]) * s;   // (m02 - m20)
		q.z = (mat.m[1] - mat.m[4]) * s;   // (m10 - m01)
	} else if (m00 > m11 && m00 > m22) {
		const float s = 2.0f * std::sqrt(1.0f + m00 - m11 - m22);
		q.r = (mat.m[6] - mat.m[9]) / s;
		q.x = 0.25f * s;
		q.y = (mat.m[4] + mat.m[1]) / s;   // (m01 + m10)
		q.z = (mat.m[8] + mat.m[2]) / s;   // (m02 + m20)
	} else if (m11 > m22) {
		const float s = 2.0f * std::sqrt(1.0f + m11 - m00 - m22);
		q.r = (mat.m[8] - mat.m[2]) / s;
		q.x = (mat.m[4] + mat.m[1]) / s;
		q.y = 0.25f * s;
		q.z = (mat.m[9] + mat.m[6]) / s;   // (m12 + m21)
	} else {
		const float s = 2.0f * std::sqrt(1.0f + m22 - m00 - m11);
		q.r = (mat.m[1] - mat.m[4]) / s;
		q.x = (mat.m[8] + mat.m[2]) / s;
		q.y = (mat.m[9] + mat.m[6]) / s;
		q.z = 0.25f * s;
	}
	return q;
}


// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const CQuaternion& CQuaternion::AssertNormalized(const CQuaternion& q)
{
	assert(q.Normalized());
	return q;
}

bool CQuaternion::Normalized() const
{
	return (std::fabs(SqNorm() - 1.0f) < 1e-4f);
}

CQuaternion& CQuaternion::Normalize()
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float sqn = SqNorm();
	if (sqn > std::numeric_limits<float>::epsilon()) {
		const float invLen = InvSqrt(sqn);
		x *= invLen;
		y *= invLen;
		z *= invLen;
		r *= invLen;
	}
	return *this;
}

// Approximate normalize — same as Normalize() here (hardware sqrt is fast)
CQuaternion& CQuaternion::ANormalize()
{
	RECOIL_DETAILED_TRACY_ZONE;
	return Normalize();
}


// ---------------------------------------------------------------------------
// Inverse
// ---------------------------------------------------------------------------

// General inverse: q^-1 = conjugate(q) / |q|^2
CQuaternion CQuaternion::Inverse() const
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float sqn = SqNorm();
	if (sqn < std::numeric_limits<float>::epsilon())
		return CQuaternion();
	const float invSqn = 1.0f / sqn;
	return CQuaternion(-x * invSqn, -y * invSqn, -z * invSqn, r * invSqn);
}

CQuaternion& CQuaternion::InverseInPlace()
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float sqn = SqNorm();
	if (sqn < std::numeric_limits<float>::epsilon())
		return *this = CQuaternion();
	const float invSqn = 1.0f / sqn;
	x = -x * invSqn;
	y = -y * invSqn;
	z = -z * invSqn;
	r =  r * invSqn;
	return *this;
}

// For unit quaternions, inverse == conjugate
CQuaternion CQuaternion::InverseNormalized() const
{
	return CQuaternion(-x, -y, -z, r);
}

CQuaternion& CQuaternion::InverseInPlaceNormalized()
{
	x = -x;
	y = -y;
	z = -z;
	// r unchanged
	return *this;
}


// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

// Returns float4(axis.x, axis.y, axis.z, angle_radians)
float4 CQuaternion::ToAxisAndAngle() const
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float clampedR = std::max(-1.0f, std::min(1.0f, r));
	const float angle    = 2.0f * std::acos(clampedR);
	const float sinHalf  = std::sqrt(std::max(0.0f, 1.0f - clampedR * clampedR));

	if (sinHalf < 1e-6f) {
		// Near-zero rotation — axis is arbitrary
		return float4(0.0f, 1.0f, 0.0f, angle);
	}
	const float invSinHalf = 1.0f / sinHalf;
	return float4(x * invSinHalf, y * invSinHalf, z * invSinHalf, angle);
}

// Returns the 4x4 rotation matrix for this unit quaternion (column-major).
CMatrix44f CQuaternion::ToRotMatrix() const
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float xx = x * x, yy = y * y, zz = z * z;
	const float xy = x * y, xz = x * z, yz = y * z;
	const float rx = r * x, ry = r * y, rz = r * z;

	// CMatrix44f constructor takes column-major values in column order:
	//   CMatrix44f(col0[0],col0[1],col0[2],col0[3],  col1...  col2...  col3...)
	return CMatrix44f(
		// col 0 (X axis)
		1.0f - 2.0f*(yy+zz),  2.0f*(xy+rz),          2.0f*(xz-ry),         0.0f,
		// col 1 (Y axis)
		2.0f*(xy-rz),          1.0f - 2.0f*(xx+zz),   2.0f*(yz+rx),         0.0f,
		// col 2 (Z axis)
		2.0f*(xz+ry),          2.0f*(yz-rx),           1.0f - 2.0f*(xx+yy),  0.0f,
		// col 3 (translation — identity)
		0.0f,                  0.0f,                   0.0f,                  1.0f
	);
}


// ---------------------------------------------------------------------------
// Vector rotation
// ---------------------------------------------------------------------------

float3 CQuaternion::Rotate(const float3& v) const
{
	RECOIL_DETAILED_TRACY_ZONE;
	// Efficient sandwich product using the identity:
	//   q v q* = v + 2r*(q.imag x v) + 2*(q.imag x (q.imag x v))
	// Simplified to: v + r*t + q.imag x t   where t = 2*(q.imag x v)
	const float3 qv(x, y, z);
	const float3 t = 2.0f * qv.cross(v);
	return v + r * t + qv.cross(t);
}

float4 CQuaternion::Rotate(const float4& v) const
{
	RECOIL_DETAILED_TRACY_ZONE;
	const float3 rotated = Rotate(float3(v.x, v.y, v.z));
	return float4(rotated.x, rotated.y, rotated.z, v.w);
}


// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

bool CQuaternion::equals(const CQuaternion& rhs) const
{
	static constexpr float eps = 1e-5f;
	return (std::fabs(x - rhs.x) < eps &&
	        std::fabs(y - rhs.y) < eps &&
	        std::fabs(z - rhs.z) < eps &&
	        std::fabs(r - rhs.r) < eps);
}


// ---------------------------------------------------------------------------
// Quaternion multiplication and scalar operators
// ---------------------------------------------------------------------------

// Hamilton product: (p * q) applies q's rotation first, then p's
CQuaternion CQuaternion::operator*(const CQuaternion& rhs) const
{
	RECOIL_DETAILED_TRACY_ZONE;
	return CQuaternion(
		r*rhs.x + x*rhs.r + y*rhs.z - z*rhs.y,
		r*rhs.y - x*rhs.z + y*rhs.r + z*rhs.x,
		r*rhs.z + x*rhs.y - y*rhs.x + z*rhs.r,
		r*rhs.r - x*rhs.x - y*rhs.y - z*rhs.z
	);
}

CQuaternion& CQuaternion::operator*=(float f)
{
	x *= f;
	y *= f;
	z *= f;
	r *= f;
	return *this;
}

CQuaternion& CQuaternion::operator/=(float f)
{
	const float finv = 1.0f / f;
	x *= finv;
	y *= finv;
	z *= finv;
	r *= finv;
	return *this;
}


// ---------------------------------------------------------------------------
// Debug helpers
// ---------------------------------------------------------------------------

void CQuaternion::AssertNaNs() const
{
	assert(!std::isnan(x) && !std::isnan(y) && !std::isnan(z) && !std::isnan(r));
	assert(!std::isinf(x) && !std::isinf(y) && !std::isinf(z) && !std::isinf(r));
}


// ---------------------------------------------------------------------------
// Fast inverse square root
// ---------------------------------------------------------------------------

float CQuaternion::InvSqrt(float f)
{
	RECOIL_DETAILED_TRACY_ZONE;
	return 1.0f / std::sqrt(f);
}


// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

CQuaternion CQuaternion::Lerp(const CQuaternion& q1, const CQuaternion& q2, const float a)
{
	RECOIL_DETAILED_TRACY_ZONE;
	// Ensure we take the shorter arc
	const float dot  = q1.x*q2.x + q1.y*q2.y + q1.z*q2.z + q1.r*q2.r;
	const float sign = (dot < 0.0f) ? -1.0f : 1.0f;

	CQuaternion result(
		q1.x + a * (sign*q2.x - q1.x),
		q1.y + a * (sign*q2.y - q1.y),
		q1.z + a * (sign*q2.z - q1.z),
		q1.r + a * (sign*q2.r - q1.r)
	);
	return result.Normalize();
}

CQuaternion CQuaternion::SLerp(const CQuaternion& q1, const CQuaternion& q2, const float a)
{
	RECOIL_DETAILED_TRACY_ZONE;
	float dot = q1.x*q2.x + q1.y*q2.y + q1.z*q2.z + q1.r*q2.r;

	// Take the shorter arc
	CQuaternion q2s = q2;
	if (dot < 0.0f) {
		dot  = -dot;
		q2s  = -q2s;
	}

	// Clamp to valid acos range and fall back to Lerp when nearly identical
	dot = std::min(dot, 1.0f);
	if (dot > 1.0f - 1e-6f)
		return Lerp(q1, q2s, a);

	const float theta    = std::acos(dot);
	const float sinTheta = std::sin(theta);
	const float w1 = std::sin((1.0f - a) * theta) / sinTheta;
	const float w2 = std::sin(a * theta)           / sinTheta;

	return CQuaternion(
		w1*q1.x + w2*q2s.x,
		w1*q1.y + w2*q2s.y,
		w1*q1.z + w2*q2s.z,
		w1*q1.r + w2*q2s.r
	);
}
