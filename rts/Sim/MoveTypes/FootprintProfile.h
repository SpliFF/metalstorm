/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef FOOTPRINT_PROFILE_H
#define FOOTPRINT_PROFILE_H

/* FootprintProfile — Metalstorm mixed-size group flow, engine ask F1
 * (PLAN-metalstorm-flow.md §1 + §3).
 *
 * A per-def authored "underside" shared by sim and client. The SIM derives a
 * hull mask + per-move-class permeability (which small move classes may flow
 * UNDER a big unit's hull, and in which motion states); the CLIENT derives
 * animated ground-contact patches (feet/tracks). Both hang off the same
 * profile so they can never disagree about what a big unit's underside is.
 *
 * Parsed from `gamedata/footprints.lua` at startup by FootprintProfileHandler,
 * resolved against the MoveDefHandler (underpass NAMES → MoveDef pathTypes),
 * attached to each opting UnitDef (customparams.footprint_profile), and
 * exported to the client by LuaDefsSerializer.
 *
 * Scope note (this fire): F1 (parse/resolve/attach/export) + the F2 passability
 * decision (PassabilityFor, wired into CMoveMath::ObjectBlockType) are landed.
 * The graded ×2 movement COST (F2b), swept-corridor stamping (F5), mass-yield
 * (F4) and flow fields (F3) are deferred — see PLAN-metalstorm-flow.md §7/§8.
 */

#include <string>
#include <vector>
#include <cstdint>

#include "System/UnorderedMap.hpp"

class LuaTable;
class MoveDefHandler;
class CUnitDefHandler;

namespace footprint {

/// Result of the F2 permeability query for one (crossing move class, big-unit
/// motion state) pair against a profile.
enum class Passability {
	Solid,             ///< the hull blocks this class (default)
	PassableWithCost,  ///< this class may thread under the hull at extra cost
};

/// The ×2 movement-cost multiplier the plan assigns to underpassing
/// (PLAN-metalstorm-flow §3: "prefer around, allow through when pressed").
/// Carried on PassableWithCost results for the graded-cost stamp (F2b, not yet
/// applied in the pathing cost layer — see the header scope note).
constexpr float kUnderpassCostMult = 2.0f;

/// Motion state of the big (hull-owning) unit, as seen by the permeability rule
/// (PLAN-metalstorm-flow §3): underpass is allowed while moving/stopped and
/// BLOCKED during turn-in-place (rotation sweeps the contacts unpredictably).
enum class HullMotion {
	Stopped,
	Moving,
	TurningInPlace,
};

struct Contact {
	enum class Kind { Foot, Track };

	Kind kind = Kind::Foot;
	float x = 0.0f;  ///< unit-local, elmos
	float z = 0.0f;

	// foot: a planted disc
	float r = 0.0f;         ///< foot radius
	float gaitPhase = 0.0f; ///< [0,1) phase offset in the walk cycle
	float gaitDuty  = 0.0f; ///< [0,1] fraction of the cycle this foot is planted

	// track: a strip (always in contact, no gait)
	float halfWidth  = 0.0f;
	float halfLength = 0.0f;
};

struct Profile {
	std::string name;

	int hullX = 0;      ///< outer sim footprint (elmos, axis-aligned in unit space)
	int hullZ = 0;
	int clearance = 0;  ///< ground clearance of the hull between contacts (elmos)

	/// authored move-class names permitted underneath (lowercased on resolve)
	std::vector<std::string> underpass;
	/// resolved MoveDef pathTypes for `underpass` (filled by ResolveMoveClasses)
	std::vector<uint32_t> underpassPathTypes;

	std::vector<Contact> contacts;

	/// F2 permeability core (pure): does move class `pathType` see this hull as
	/// passable (rather than solid), ignoring motion state?
	bool PermitsUnderpass(uint32_t pathType) const {
		for (uint32_t pt : underpassPathTypes) {
			if (pt == pathType)
				return true;
		}
		return false;
	}

	/// F2 permeability decision: passability of this hull for a crossing move
	/// class in a given hull motion state (PLAN-metalstorm-flow §3). Blocked
	/// (Solid) unless the class is permitted AND the hull is not turning in
	/// place; otherwise PassableWithCost (×2, kUnderpassCostMult).
	Passability PassabilityFor(uint32_t pathType, HullMotion motion) const {
		if (!PermitsUnderpass(pathType))
			return Passability::Solid;
		if (motion == HullMotion::TurningInPlace)
			return Passability::Solid;
		return Passability::PassableWithCost;
	}
};

} // namespace footprint

class FootprintProfileHandler {
public:
	/// Load + parse `gamedata/footprints.lua` from the mod VFS (runtime path).
	/// Returns false and logs on parse error; missing file is not an error
	/// (games without footprint profiles simply have none).
	bool Load();

	/// Parse profiles from an inline Lua chunk (test / tooling path). Same
	/// grammar as the file; funnels through the shared table parser.
	bool LoadFromChunk(const std::string& luaText);

	/// Resolve every profile's underpass NAMES to MoveDef pathTypes. Requires a
	/// populated MoveDefHandler (map present). Safe to skip on the no-map export
	/// path — the client export uses the raw names, and the sim permeability
	/// query only runs when a map (and thus MoveDefs) exist.
	void ResolveMoveClasses(MoveDefHandler& mdh);

	/// Attach the resolved profile pointer to every UnitDef whose
	/// customparams.footprint_profile names one (logs unknown keys).
	void AttachToUnitDefs(CUnitDefHandler& udh);

	const footprint::Profile* Get(const std::string& key) const {
		const auto it = profiles.find(key);
		return (it != profiles.end()) ? &it->second : nullptr;
	}

	size_t Size() const { return profiles.size(); }
	void Clear() { profiles.clear(); }

private:
	bool ParseRoot(const LuaTable& root);

	spring::unordered_map<std::string, footprint::Profile> profiles;
};

extern FootprintProfileHandler footprintProfileHandler;

#endif // FOOTPRINT_PROFILE_H
