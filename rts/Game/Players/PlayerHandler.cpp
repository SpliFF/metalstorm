/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include <algorithm>
#include <cassert>

#include "PlayerHandler.h"
#include "Sim/Misc/GlobalConstants.h"
#include "Game/GameSetup.h"

CR_BIND(CPlayerHandler,)

CR_REG_METADATA(CPlayerHandler, (
	CR_MEMBER(players)
))


CPlayerHandler playerHandler;


void CPlayerHandler::ResetState()
{
	players.clear();
	players.reserve(MAX_PLAYERS);
}

void CPlayerHandler::LoadFromSetup(const CGameSetup* setup)
{
	const std::vector<PlayerBase>& playerData = setup->GetPlayerStartingDataCont();

	const int oldSize = players.size();
	const int newSize = std::max(players.size(), playerData.size());

	assert(newSize <= MAX_PLAYERS);
	assert(players.capacity() == MAX_PLAYERS);

	for (unsigned int i = oldSize; i < newSize; ++i) {
		players.emplace_back();
	}

	for (size_t i = 0; i < playerData.size(); ++i) {
		players[i] = playerData[i];

		players[i].playerNum = int(i);
	}
}


int CPlayerHandler::Player(const std::string& name) const
{
	const auto pred = [&name](const CPlayer& player) { return (player.name == name); };
	const auto iter = std::find_if(players.begin(), players.end(), pred);

	if (iter != players.end())
		return (iter->playerNum);

	return -1;
}

int CPlayerHandler::HumanPlayer(const std::string& name) const
{
	if (name.empty())
		return -1;   // a reserved-but-unclaimed slot is nameless; it owns nobody

	for (const CPlayer& player: players) {
		if (player.isAI)
			continue;
		if (player.name == name)
			return player.playerNum;
	}

	return -1;
}


void CPlayerHandler::ReserveSlots(int count, const std::vector<int>& teamOfSlot)
{
	// PLAN-metalstorm-wars.md §8.1. Grow ONLY — a pre-allocation that shrank
	// the list would delete rows other state is keyed on, and this runs once
	// during set-up in any case.
	const int oldSize = int(players.size());

	if (count <= oldSize)
		return;

	assert(count <= MAX_PLAYERS);
	assert(players.capacity() == MAX_PLAYERS);

	for (int i = oldSize; i < count; ++i) {
		players.emplace_back();

		CPlayer& slot = players.back();

		// Nameless is the marker, and it is load-bearing: `IsUnclaimedSlot`,
		// the roster broadcast's filter and HumanPlayer() all read it, and
		// AddPlayer's own gap stubs are named "unknown" precisely so the two
		// stay distinguishable. A claimed slot gets its account's name.
		slot.name = "";
		slot.isFromDemo = false;
		// Spectator until claimed, so every "who is fighting on this team"
		// question — Lua's GetPlayerList(teamID), the human-presence checks,
		// the hibernation gate — reads an empty seat as empty. `active` stays
		// false for the same reason: nobody is sitting here yet.
		slot.spectator = true;
		slot.active = false;
		// The side the seat is FOR, kept on the row so an operator dumping the
		// player list can see the shape the war was sized to. Authority over
		// the layout stays with ReservedPlayerSlots — this is a copy for
		// legibility, not the source.
		slot.team = (i < int(teamOfSlot.size()) && teamOfSlot[i] >= 0) ? teamOfSlot[i] : 0;
		slot.playerNum = i;
	}
}


bool CPlayerHandler::IsUnclaimedSlot(int id) const
{
	if (id < 0 || size_t(id) >= players.size())
		return false;

	const CPlayer& p = players[id];

	return p.name.empty() && !p.active && !p.isAI;
}

void CPlayerHandler::PlayerLeft(int id, unsigned char reason)
{
	Player(id)->active = false;
	Player(id)->ping = 0;
}



unsigned int CPlayerHandler::NumActivePlayersInTeam(int teamId) const
{
	unsigned int n = 0;

	for (const CPlayer& player: players) {
		// do not count spectators, or demos will desync
		n += (player.active && !player.spectator && player.team == teamId);
	}

	return n;
}

std::vector<int> CPlayerHandler::ActivePlayersInTeam(int teamId) const
{
	std::vector<int> playersInTeam;

	for (const CPlayer& player: players) {
		// do not count spectators, or demos will desync
		if (!player.active)
			continue;
		if (player.spectator)
			continue;
		if (player.team != teamId)
			continue;

		playersInTeam.push_back(player.playerNum);
	}

	return playersInTeam;
}



void CPlayerHandler::GameFrame(int frameNum)
{
	for (CPlayer& player: players) {
		player.GameFrame(frameNum);
	}
}

void CPlayerHandler::AddPlayer(const CPlayer& player)
{
	const int oldSize = players.size();
	const int newSize = std::max(oldSize, player.playerNum + 1);

	assert(players.capacity() == MAX_PLAYERS);
	assert((players.size() + (newSize - oldSize)) <= MAX_PLAYERS);

	{
		for (unsigned int i = oldSize; i < newSize; ++i) {
			// fill gap with stubs
			players.emplace_back();

			CPlayer& stub = players.back();
			stub.name = "unknown";

			stub.isFromDemo = false;
			stub.spectator = true;

			stub.team = 0;
			stub.playerNum = (int)i;
		}

		CPlayer* newPlayer = &players[player.playerNum];
		*newPlayer = player;
	}
}

