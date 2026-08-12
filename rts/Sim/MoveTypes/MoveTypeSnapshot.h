/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// MoveTypeSnapshot — the restorable half of a unit's move type
// (PLAN-persistence §7.1c option A).
//
// WHY THIS EXISTS AT ALL
// ----------------------
// §7.1c decided that no AMoveType state was captured: `inCommand` is forced
// false on restore, the front command is re-entered, and the move goal is
// rebuilt from the command itself. That is true and still holds — but it only
// rebuilds the *goal*. Everything between the goal and the wheels — current
// speed, turn speed, the waypoint pair, the idling counters, an aircraft's
// flight state — starts at its constructor value, so a restored unit stands
// still until its next SlowUpdate (up to UNIT_SLOWUPDATE_RATE frames later)
// and then accelerates from zero. The Q-P2 measurement sized that: 64 of 100
// units end up in a different place after 100 ticks, the worst by 116 elmos.
//
// WHAT IT IS NOT
// --------------
// A path handle is not state. `pathID`/`nextPathId`/`deletePathId` index live
// CPathManager objects that do not survive the process, and a path is a pure
// function of (position, goal, MoveDef) that the engine re-requests routinely
// during play. The restore leaves `pathID` at 0 and lets the owner's next
// SlowUpdate re-request through the branch that already exists for it ("we
// want to be moving but don't have a path"). Re-requesting during the apply
// itself was tried and reverted: StartEngine() writes back over the waypoint
// pair and two other restored fields, so the checkpoint re-captured straight
// after being applied stopped matching the one applied — it broke §8's
// byte-exact restore bar to buy nothing measurable.
//
// This is the declared gap in option A, and the 300:100 measurement says it is
// the WHOLE of the residue: capturing every member of every move type moved
// the continuation drift from 64/100 units (max 116.1 elmos) to 61/100 (max
// 117.0). What actually re-plans a restored unit is §7.1c decision 1 — the
// front command is re-entered from scratch, which re-derives the goal and asks
// for a new path — and no amount of move-type state changes that.
//
// LAYOUT
// ------
// One struct per class in the hierarchy rather than a flat union of every
// field, so the codec writes only the arm the unit actually has and a census
// can be written per class. `kind` is the discriminant and is derived from the
// live object, never from the def — a unit under Lua move control is running a
// CScriptMoveType with its real move type parked in `prevMoveType`, and both
// halves are captured (`scriptControlled` + `prev`).
#pragma once

#include <cstdint>

namespace movetypesnapshot {

enum class Kind : uint8_t {
	None     = 0,   ///< unit has no move type at all (should not happen; encoded honestly if it does)
	Static   = 1,
	Ground   = 2,
	HoverAir = 3,
	StrafeAir = 4,
	Script   = 5,
};

/// AMoveType — the members every move type has.
struct BaseState {
	float goalX = 0.0f, goalY = 0.0f, goalZ = 0.0f;
	float oldPosX = 0.0f, oldPosY = 0.0f, oldPosZ = 0.0f;
	float oldSlowUpdatePosX = 0.0f, oldSlowUpdatePosY = 0.0f, oldSlowUpdatePosZ = 0.0f;
	float oldCollisionUpdatePosX = 0.0f, oldCollisionUpdatePosY = 0.0f, oldCollisionUpdatePosZ = 0.0f;
	int32_t progressState = 0;
	float maxSpeed = 0.0f, maxSpeedDef = 0.0f, maxWantedSpeed = 0.0f;
	float maneuverLeash = 0.0f, waterline = 0.0f;
	bool useHeading = true;
	bool useWantedSpeed0 = true, useWantedSpeed1 = true;
};

/// CGroundMoveType. Everything but the three path handles, `jobId` (a
/// per-frame multi-threading slot, re-assigned by the move system before it is
/// read) and `pathController` (stateless — GMTDefaultPathController holds only
/// its owner pointer).
struct GroundState {
	float currWayPointX = 0.0f, currWayPointY = 0.0f, currWayPointZ = 0.0f;
	float nextWayPointX = 0.0f, nextWayPointY = 0.0f, nextWayPointZ = 0.0f;
	float earlyCurrWayPointX = 0.0f, earlyCurrWayPointY = 0.0f, earlyCurrWayPointZ = 0.0f;
	float earlyNextWayPointX = 0.0f, earlyNextWayPointY = 0.0f, earlyNextWayPointZ = 0.0f;
	float waypointDirX = 0.0f, waypointDirY = 0.0f, waypointDirZ = 0.0f;
	float flatFrontDirX = 0.0f, flatFrontDirY = 0.0f, flatFrontDirZ = 0.0f;
	float lastAvoidanceDirX = 0.0f, lastAvoidanceDirY = 0.0f, lastAvoidanceDirZ = 0.0f;
	float mainHeadingPosX = 0.0f, mainHeadingPosY = 0.0f, mainHeadingPosZ = 0.0f;
	float skidRotVectorX = 0.0f, skidRotVectorY = 0.0f, skidRotVectorZ = 0.0f;

	float turnRate = 0.1f, turnSpeed = 0.0f, turnAccel = 0.0f;
	float accRate = 0.01f, decRate = 0.01f, myGravity = 0.0f;
	float maxReverseDist = 0.0f, minReverseAngle = 0.0f, maxReverseSpeed = 0.0f;
	float sqSkidSpeedMult = 0.95f;
	float wantedSpeed = 0.0f, currentSpeed = 0.0f, deltaSpeed = 0.0f;
	float currWayPointDist = 0.0f, prevWayPointDist = 0.0f;
	float goalRadius = 0.0f, ownerRadius = 0.0f, extraRadius = 0.0f;
	float skidRotSpeed = 0.0f, skidRotAccel = 0.0f;

	float forceFromMovingCollideesX = 0.0f, forceFromMovingCollideesY = 0.0f, forceFromMovingCollideesZ = 0.0f;
	float forceFromStaticCollideesX = 0.0f, forceFromStaticCollideesY = 0.0f, forceFromStaticCollideesZ = 0.0f;
	float resultantForcesX = 0.0f, resultantForcesY = 0.0f, resultantForcesZ = 0.0f;

	uint32_t numIdlingUpdates = 0, numIdlingSlowUpdates = 0;
	int32_t wantedHeading = 0, minScriptChangeHeading = 0;
	int32_t wantRepathFrame = 0, lastRepathFrame = 0;
	float bestLastWaypointDist = 0.0f, bestReattemptedLastWaypointDist = 0.0f;
	int32_t setHeading = 0, setHeadingDir = 0, limitSpeedForTurning = 0;
	float oldSpeed = 0.0f, newSpeed = 0.0f;

	bool atGoal = true, atEndOfPath = true, wantRepath = false;
	bool moveFailed = false, lastWaypoint = false;
	bool reversing = false, idling = false;
	bool pushResistant = false, pushResistanceBlockActive = false, canReverse = false;
	bool useMainHeading = false, useRawMovement = false;
	bool pathingFailed = false, pathingArrived = false, positionStuck = false;
	bool forceStaticObjectCheck = false, avoidingUnits = false;
};

/// AAirMoveType — the members CHoverAirMoveType and CStrafeAirMoveType share.
/// `lastCollidee` is a pointer re-derived by CheckForCollision every frame and
/// is not captured; `crashExpGenID` is a def-resolved explosion-generator id.
struct AirState {
	int32_t aircraftState = 0, collisionState = 0;
	float oldGoalPosX = 0.0f, oldGoalPosY = 0.0f, oldGoalPosZ = 0.0f;
	float reservedLandingPosX = -1.0f, reservedLandingPosY = -1.0f, reservedLandingPosZ = -1.0f;
	float landRadiusSq = 0.0f, wantedHeight = 80.0f, orgWantedHeight = 0.0f;
	float accRate = 1.0f, decRate = 1.0f, altitudeRate = 3.0f;
	bool collide = true, autoLand = true, dontLand = false;
	bool useSmoothMesh = false, canSubmerge = false, floatOnWater = false;
};

/// CHoverAirMoveType.
struct HoverState {
	int32_t flyState = 0;
	bool bankingAllowed = true, airStrafe = true, wantToStop = false;
	float goalDistance = 1.0f;
	float currentBank = 0.0f, currentPitch = 0.0f;
	float turnRate = 1.0f, maxDrift = 1.0f, maxTurnAngle = 1.0f;
	float wantedSpeedX = 0.0f, wantedSpeedY = 0.0f, wantedSpeedZ = 0.0f;
	float deltaSpeedX = 0.0f, deltaSpeedY = 0.0f, deltaSpeedZ = 0.0f;
	float circlingPosX = 0.0f, circlingPosY = 0.0f, circlingPosZ = 0.0f;
	float randomWindX = 0.0f, randomWindY = 0.0f, randomWindZ = 0.0f;
	bool forceHeading = false;
	int32_t wantedHeading = 0, forcedHeading = 0;
	int32_t waitCounter = 0, lastMoveRate = 0;
};

/// CStrafeAirMoveType.
struct StrafeState {
	int32_t maneuverBlockTime = 0, maneuverState = 0, maneuverSubState = 0;
	bool loopbackAttack = false, isFighter = false;
	float wingDrag = 0.07f, wingAngle = 0.1f, invDrag = 0.995f, crashDrag = 0.995f;
	float frontToSpeed = 0.04f, speedToFront = 0.01f, myGravity = 0.8f;
	float maxBank = 0.55f, maxPitch = 0.35f, turnRadius = 150.0f;
	float maxAileron = 0.04f, maxElevator = 0.02f, maxRudder = 0.01f;
	float attackSafetyDistance = 0.0f;
	float crashAileron = 0.0f, crashElevator = 0.0f, crashRudder = 0.0f;
	float lastRudderPos0 = 0.0f, lastRudderPos1 = 0.0f;
	float lastElevatorPos0 = 0.0f, lastElevatorPos1 = 0.0f;
	float lastAileronPos0 = 0.0f, lastAileronPos1 = 0.0f;
};

/// CScriptMoveType — a unit under Lua move control (Spring.MoveCtrl.*).
struct ScriptState {
	float velVecX = 0.0f, velVecY = 0.0f, velVecZ = 0.0f;
	float relVelX = 0.0f, relVelY = 0.0f, relVelZ = 0.0f;
	float rotX = 0.0f, rotY = 0.0f, rotZ = 0.0f;
	float rotVelX = 0.0f, rotVelY = 0.0f, rotVelZ = 0.0f;
	float minsX = 0.0f, minsY = 0.0f, minsZ = 0.0f;
	float maxsX = 0.0f, maxsY = 0.0f, maxsZ = 0.0f;
	int32_t tag = 0;
	float drag = 0.0f, groundOffset = 0.0f, gravityFactor = 0.0f, windFactor = 0.0f;
	bool extrapolate = true, useRelVel = false, useRotVel = false;
	bool trackSlope = false, trackGround = false, trackLimits = false;
	bool noBlocking = false, groundStop = false, limitsStop = false;
	int32_t scriptNotify = 0;
};

/// One unit's move type, tagged. Only the arm named by `kind` is meaningful;
/// the codec writes only that arm, so two captures of the same world stay
/// byte-comparable without the unwritten arms having to agree.
struct MoveTypeState {
	uint8_t kind = static_cast<uint8_t>(Kind::None);
	BaseState base;
	GroundState ground;
	AirState air;
	HoverState hover;
	StrafeState strafe;
	ScriptState script;

	/// Set when the live move type is a CScriptMoveType installed over a real
	/// one (CUnit::prevMoveType). `kind`/`base` then describe the PARKED type,
	/// `script` the controller on top of it — restoring only the controller
	/// would silently turn a tank into a script-driven object forever.
	bool scriptControlled = false;
	BaseState scriptBase;   ///< the CScriptMoveType's own AMoveType half
};

} // namespace movetypesnapshot
