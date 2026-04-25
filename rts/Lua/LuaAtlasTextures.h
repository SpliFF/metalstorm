/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef LUA_ATLAS_TEXTURES_H
#define LUA_ATLAS_TEXTURES_H

#include <string>
#include <vector>
#include <unordered_map>

// Headless server: texture atlas is rendering-only, stub the interface
class CTextureAtlas;

class LuaAtlasTextures {
public:
	static constexpr char prefix = '*';
	static constexpr size_t invalidIndex = size_t(-1);

	~LuaAtlasTextures() { Clear(); }
	LuaAtlasTextures() {}

	void Clear();

	std::string Create(const int xsize, const int ysize, const int allocatorType = 0);
	bool Delete(const std::string& idStr);
	CTextureAtlas* GetAtlasById(const std::string& idStr) const;
	CTextureAtlas* GetAtlasByIndex(const size_t index) const;
	size_t GetAtlasIndexById(const std::string& idStr) const;
private:
	using TextureAtlasMap = std::unordered_map<std::string, std::size_t>;
	using TextureAtlasVec = std::vector<CTextureAtlas*>;
private:
	TextureAtlasMap textureAtlasMap;
	TextureAtlasVec textureAtlasVec;
};

#endif /* LUA_ATLAS_TEXTURES_H */
