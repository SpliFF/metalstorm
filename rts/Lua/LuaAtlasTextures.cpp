/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// Headless server: texture atlas operations are no-ops
#include "LuaAtlasTextures.h"

void LuaAtlasTextures::Clear() {
	textureAtlasVec.clear();
	textureAtlasMap.clear();
}

std::string LuaAtlasTextures::Create(const int xsize, const int ysize, const int allocatorType) { return ""; }
bool LuaAtlasTextures::Delete(const std::string& idStr) { return false; }
CTextureAtlas* LuaAtlasTextures::GetAtlasById(const std::string& idStr) const { return nullptr; }
CTextureAtlas* LuaAtlasTextures::GetAtlasByIndex(const size_t index) const { return nullptr; }
size_t LuaAtlasTextures::GetAtlasIndexById(const std::string& idStr) const { return invalidIndex; }
