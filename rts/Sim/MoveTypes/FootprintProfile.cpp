/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "FootprintProfile.h"

#include "Sim/MoveTypes/MoveDefHandler.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/UnitDef.h"
#include "Lua/LuaParser.h"
#include "System/FileSystem/FileHandler.h"
#include "System/FileSystem/VFSModes.h"
#include "System/StringUtil.h"
#include "System/Log/ILog.h"

FootprintProfileHandler footprintProfileHandler;

namespace {
	// customparams key a unit uses to opt into a profile (lowercased by the
	// Lua reader, so match lowercase — PLAN-metalstorm-flow §1).
	constexpr const char* kProfileKeyParam = "footprint_profile";

	footprint::Contact::Kind ParseKind(const std::string& s) {
		return (StringToLower(s) == "track")
			? footprint::Contact::Kind::Track
			: footprint::Contact::Kind::Foot;
	}
}


bool FootprintProfileHandler::Load()
{
	// Absent file is the common case (most games declare no footprint profiles):
	// stay silent rather than warn on every boot.
	if (!CFileHandler::FileExists("gamedata/footprints.lua", SPRING_VFS_MOD_BASE))
		return false;

	LuaParser parser("gamedata/footprints.lua", SPRING_VFS_MOD_BASE, SPRING_VFS_ZIP);
	if (!parser.Execute()) {
		// A missing file is not an error: most games have no footprint profiles.
		// Distinguish a genuine parse error (file present, bad Lua) from absence
		// by checking the error text — LuaParser reports "could not open" style
		// messages for a missing chunk. Either way there is nothing to attach.
		const std::string& err = parser.GetErrorLog();
		if (!err.empty())
			LOG_L(L_WARNING, "[FootprintProfileHandler] gamedata/footprints.lua: %s", err.c_str());
		return false;
	}
	return ParseRoot(parser.GetRoot());
}


bool FootprintProfileHandler::LoadFromChunk(const std::string& luaText)
{
	LuaParser parser(luaText, SPRING_VFS_MOD_BASE);
	if (!parser.Execute()) {
		LOG_L(L_WARNING, "[FootprintProfileHandler] chunk parse error: %s", parser.GetErrorLog().c_str());
		return false;
	}
	return ParseRoot(parser.GetRoot());
}


bool FootprintProfileHandler::ParseRoot(const LuaTable& root)
{
	if (!root.IsValid())
		return false;

	std::vector<std::string> keys;
	root.GetKeys(keys); // profile keys are lowercased by the reader

	for (const std::string& key : keys) {
		const LuaTable profileTable = root.SubTable(key);
		if (!profileTable.IsValid())
			continue;

		footprint::Profile p;
		p.name = key;

		const LuaTable hull = profileTable.SubTable("hull");
		p.hullX = hull.GetInt("x", 0);
		p.hullZ = hull.GetInt("z", 0);
		p.clearance = profileTable.GetInt("clearance", 0);

		// underpass: an array of move-class names (kept verbatim here; lowercased
		// on resolve so they match MoveDef names, which the reader lowercases).
		const LuaTable underpass = profileTable.SubTable("underpass");
		const int nClasses = underpass.GetLength();
		for (int i = 1; i <= nClasses; i++) {
			const std::string cls = underpass.GetString(i, "");
			if (!cls.empty())
				p.underpass.push_back(cls);
		}

		// contacts: ordered array of foot/track elements
		const LuaTable contacts = profileTable.SubTable("contacts");
		const int nContacts = contacts.GetLength();
		for (int i = 1; i <= nContacts; i++) {
			const LuaTable ct = contacts.SubTable(i);
			if (!ct.IsValid())
				continue;

			footprint::Contact c;
			c.kind = ParseKind(ct.GetString("kind", "foot"));
			c.x = ct.GetFloat("x", 0.0f);
			c.z = ct.GetFloat("z", 0.0f);

			if (c.kind == footprint::Contact::Kind::Foot) {
				c.r = ct.GetFloat("r", 0.0f);
				const LuaTable gait = ct.SubTable("gait");
				c.gaitPhase = gait.GetFloat("phase", 0.0f);
				c.gaitDuty  = gait.GetFloat("duty", 0.0f);
			} else {
				c.halfWidth  = ct.GetFloat("halfWidth",  0.0f);
				c.halfLength = ct.GetFloat("halfLength", 0.0f);
			}
			p.contacts.push_back(c);
		}

		profiles[key] = std::move(p);
	}

	return true;
}


void FootprintProfileHandler::ResolveMoveClasses(MoveDefHandler& mdh)
{
	for (auto& kv : profiles) {
		footprint::Profile& p = kv.second;
		p.underpassPathTypes.clear();
		p.underpassPathTypes.reserve(p.underpass.size());

		for (const std::string& cls : p.underpass) {
			const std::string lc = StringToLower(cls);
			const MoveDef* md = mdh.GetMoveDefByName(lc);
			if (md == nullptr) {
				LOG_L(L_WARNING,
					"[FootprintProfileHandler] profile '%s' names unknown underpass move class '%s'",
					p.name.c_str(), cls.c_str());
				continue;
			}
			p.underpassPathTypes.push_back(md->pathType);
		}
	}
}


void FootprintProfileHandler::AttachToUnitDefs(CUnitDefHandler& udh)
{
	if (profiles.empty())
		return;

	std::vector<UnitDef>& defs = udh.GetUnitDefsVecMut();
	for (UnitDef& ud : defs) {
		const auto it = ud.customParams.find(kProfileKeyParam);
		if (it == ud.customParams.end())
			continue;

		const footprint::Profile* p = Get(StringToLower(it->second));
		if (p == nullptr) {
			LOG_L(L_WARNING,
				"[FootprintProfileHandler] unit '%s' references unknown footprint_profile '%s'",
				ud.name.c_str(), it->second.c_str());
			continue;
		}
		ud.footprintProfile = p;
	}
}
