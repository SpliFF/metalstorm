/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef PLAYER_HANDLER_H
#define PLAYER_HANDLER_H

#include "Game/Players/Player.h"
#include "System/creg/creg_cond.h"

#include <cassert>
#include <string>
#include <vector>

class CGameSetup;

class CPlayerHandler
{
public:
	CR_DECLARE_STRUCT(CPlayerHandler)

	void ResetState();
	void LoadFromSetup(const CGameSetup* setup);

	/**
	 * @brief Player
	 * @param id index to fetch
	 * @return CPlayer pointer
	 *
	 * Accesses a CPlayer instance at a given index
	 */
	CPlayer* Player(int id) { assert(unsigned(id) < players.size()); return &players[id]; }

	/**
	 * @brief Player
	 * @param name name of the player
	 * @return his playernumber of -1 if not found
	 *
	 * Search a player by name.
	 */
	int Player(const std::string& name) const;

	/**
	 * @brief the playerNum a returning HUMAN account already owns
	 * @param name account username
	 * @return its playerNum, or -1 if this account has never authenticated
	 *
	 * PLAN-long-uptime S12. `players` is capacity-pinned to MAX_PLAYERS and
	 * nothing ever erases from it — a disconnect only clears `active` — so a
	 * server that appends a row per authentication walks into a hard ceiling
	 * in tab reloads rather than in distinct players. Authentication resolves
	 * a username back through here and reuses the row it finds.
	 *
	 * Differs from Player(name) by skipping AI virtual players: they are
	 * named "AI:<id>@t<team>", which cannot collide with an account name,
	 * but `isAI` is what the rule is about so that is what it tests.
	 * Inactive rows ARE matched — a disconnected player is exactly the case
	 * this exists for.
	 */
	int HumanPlayer(const std::string& name) const;

	void PlayerLeft(int id, unsigned char reason);

	/**
	 * @brief Number of players the game was created for
	 *
	 * Will change at runtime, for example if a new spectator joins
	 */
	int ActivePlayers() const { return players.size(); }

	unsigned int NumActivePlayersInTeam(int teamId) const;

	/**
	 * @brief Number of players in a team
	 *
	 * Will change during runtime (Connection lost, died, ...).
	 * This excludes spectators and AIs.
	 */
	std::vector<int> ActivePlayersInTeam(int teamId) const;

	/**
	 * @brief is the supplied id a valid playerId?
	 *
	 * Will change during at runtime when a new spectator joins
	 */
	bool IsValidPlayer(unsigned id) const {
		return (id < ActivePlayers());
	}

	void GameFrame(int frameNum);

	/**
	 * @brief Adds a new player for dynamic join
	 *
	 * This resizes the playerlist adding stubs if there's gaps to his playerNum
	 */
	void AddPlayer(const CPlayer& player);

	/**
	 * @brief Pre-allocate `count` player slots for a war's Σ slotCap
	 * @param count      total slots the process was spawned for
	 * @param teamOfSlot the side each slot belongs to (index = playerNum, -1 =
	 *                   no side); short or absent leaves the rest on team 0
	 *
	 * PLAN-metalstorm-wars.md §8.1. The War Director knows every side's
	 * `slotCap` when it seeds a war, so the server is sized for the WAR rather
	 * than for the roster it booted with: the block exists from frame 0 and a
	 * dynamic joiner is seated into a slot that was already there, instead of
	 * competing for a player number with every spectator who came to watch.
	 *
	 * Grows only, and the slots it adds are nameless inactive spectators — the
	 * shape AddPlayer's own gap stubs already have, so nothing downstream meets
	 * a row it has not seen before. See Server/PlayerSlotReservation.h for the
	 * layout rule and Server/ClientMessageHandler.cpp for the claim.
	 */
	void ReserveSlots(int count, const std::vector<int>& teamOfSlot);

	/**
	 * @brief is this player number a reserved slot nobody has taken yet?
	 *
	 * Nameless + inactive + not an AI. The claim path asks it to find a free
	 * seat on a side, and the roster broadcast asks it to leave empty seats off
	 * the wire — an unclaimed slot is a place, not a person.
	 */
	bool IsUnclaimedSlot(int id) const;

private:
	/**
	 * @brief players
	 *
	 * for all the players in the game
	 * must never be resized beyond MAX_PLAYERS!
	 */
	std::vector<CPlayer> players;
};

extern CPlayerHandler playerHandler;

#endif // !PLAYER_HANDLER_H
