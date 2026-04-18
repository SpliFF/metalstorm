/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "GameData.h"

GameData::GameData()
{
	std::memset(mapChecksum, 0, sizeof(mapChecksum));
	std::memset(modChecksum, 0, sizeof(modChecksum));
}
GameData::GameData(const std::string& setup): setupText(setup)
{
	std::memset(mapChecksum, 0, sizeof(mapChecksum));
	std::memset(modChecksum, 0, sizeof(modChecksum));
}

void GameData::SetSetupText(const std::string& newSetup)
{
	setupText = newSetup;
	compressed.clear();
}

