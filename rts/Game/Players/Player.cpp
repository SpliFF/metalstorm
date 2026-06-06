/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include <cassert>


#include "Player.h"
#include "PlayerHandler.h"
#include "Game/GlobalUnsynced.h"
#include "Map/ReadMap.h"
#include "Server/PlayerTeamEventCollector.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitHandler.h"
#include "System/SpringMath.h"
#include "System/EventHandler.h"
#include "System/Log/ILog.h"
#include "System/creg/creg_cond.h"


CR_BIND_DERIVED(CPlayer, PlayerBase, )
CR_REG_METADATA(CPlayer, (
	CR_MEMBER(active),
	CR_MEMBER(playerNum),
	CR_IGNORED(ping),
	CR_MEMBER(currentStats),
	CR_MEMBER(controlledTeams)
))


//////////////////////////////////////////////////////////////////////
// Construction/Destruction
//////////////////////////////////////////////////////////////////////

CPlayer::CPlayer()
{
}



void CPlayer::SetControlledTeams()
{
	controlledTeams.clear();
	controlledTeams.reserve(teamHandler.ActiveTeams());

	if (gs->godMode != 0) {
		// anyone can control any (friendly and/or enemy) unit
		for (int t = 0; t < teamHandler.ActiveTeams(); t++) {
			if ((gs->godMode & GODMODE_ATC_BIT) != 0 &&  teamHandler.AlliedTeams(team, t))
				controlledTeams.insert(t);
			if ((gs->godMode & GODMODE_ETC_BIT) != 0 && !teamHandler.AlliedTeams(team, t))
				controlledTeams.insert(t);
		}

		// facilitate LuaUnsyncedCtrl checks
		if (gs->godMode == GODMODE_MAX_VAL)
			controlledTeams.insert(CEventClient::AllAccessTeam);

		// self-control
		controlledTeams.insert(team);
		return;
	}

	if (spectator)
		return;

	// my team
	controlledTeams.insert(team);
}


void CPlayer::UpdateControlledTeams()
{
	for (int p = 0; p < playerHandler.ActivePlayers(); p++) {
		CPlayer* player = playerHandler.Player(p);

		if (player == nullptr)
			continue;

		player->SetControlledTeams();
	}
}


void CPlayer::StartSpectating()
{
	if (spectator)
		return;

	spectator = true;

	if (gu->myPlayerNum == this->playerNum) {
		gu->spectating           = true;
		gu->spectatingFullView   = true;
		gu->spectatingFullSelect = true;

		if (readMap != nullptr)
			readMap->BecomeSpectator();
	}

	StopControllingUnit();
	eventHandler.PlayerChanged(playerNum);
	playerTeamEvents.Push({PlayerTeamEventData::PlayerChanged, 0, static_cast<uint32_t>(playerNum)});
}

void CPlayer::JoinTeam(int newTeam)
{
	// a player that joins a team always stops spectating
	spectator = false;
	team = newTeam;

	if (gu->myPlayerNum == this->playerNum) {
		gu->myPlayingTeam = gu->myTeam = newTeam;
		gu->myPlayingAllyTeam = gu->myAllyTeam = teamHandler.AllyTeam(gu->myTeam);

		gu->spectating           = false;
		gu->spectatingFullView   = false;
		gu->spectatingFullSelect = false;
	}

	eventHandler.PlayerChanged(playerNum);
	playerTeamEvents.Push({PlayerTeamEventData::PlayerChanged, 0, static_cast<uint32_t>(playerNum)});
}

void CPlayer::GameFrame(int frameNum)
{
	// FPS unit control removed — was client-side rendering concern
}



void CPlayer::StartControllingUnit()
{
	// FPS unit control removed — will be re-implemented via server commands
}

void CPlayer::StopControllingUnit()
{
	// FPS unit control removed — no controllee to clean up
}
