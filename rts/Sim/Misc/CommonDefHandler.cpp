/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include <vector>

#include "Sim/Misc/GuiSoundSet.h"
#include "CommonDefHandler.h"
#include "System/Log/ILog.h"

// UnitDef and WeaponDef sound-sets; [0] is always a dummy
static std::vector<GuiSoundSetData> soundSetData;


void CommonDefHandler::InitStatic()
{
	soundSetData.clear();
	soundSetData.reserve(4096);
	soundSetData.emplace_back();
}

void CommonDefHandler::KillStatic()
{
	LOG_L(L_INFO, "[CommonDefHandler::%s] %u sound-set data items added", __func__, uint32_t(soundSetData.size()));
}


void CommonDefHandler::AddSoundSetData(GuiSoundSet& soundSet, const std::string& fileName, float volume)
{
	// NB: for each set, all data variants should be loaded sequentially
	soundSet.UpdateIndices(soundSetData.size());
	soundSetData.emplace_back(fileName, -1, volume);
}

GuiSoundSetData& CommonDefHandler::GetSoundSetData(size_t idx)
{
	return (soundSetData.at(idx));
}

size_t CommonDefHandler::SoundSetDataCount()
{
	return (soundSetData.size());
}


int CommonDefHandler::LoadSoundFile(const std::string& fileName)
{
	// Sound system removed server-side
	return 0;
}
