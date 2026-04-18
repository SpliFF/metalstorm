/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef SMFREADMAP_H
#define SMFREADMAP_H

#include "SMFMapFile.h"
#include "Map/ReadMap.h"
#include "System/EventClient.h"
#include "System/type2.h"


class CSMFReadMap : public CReadMap, public CEventClient
{
public:
	// CEventClient interface
	int GetReadAllyTeam() const override { return AllAccessTeam; }
	bool WantsEvent(const std::string& eventName) override {
		return eventName == "SunChanged";
	}

	void SunChanged() override;

public:

	CSMFReadMap(const std::string& mapName);
	~CSMFReadMap() { mapFile.Close(); }

	void UpdateHeightMapUnsynced(const SRectangle&) override;

public:
	int GetNumFeatureTypes() override;
	int GetNumFeatures() override;
	void GetFeatureInfo(MapFeatureInfo* f) override;
	const char* GetFeatureTypeName(int typeID) override;

	unsigned char* GetInfoMap(const char* name, MapBitmapInfo* bm) override;
	void FreeInfoMap(const char* name, unsigned char* data) override;

	// NOTE: do not use, just here for backward compatibility with SMFGroundTextures.cpp
	inline CSMFMapFile& GetMapFile() { return mapFile; }

public:
	// constants
	static constexpr int tileScale     = 4;
	static constexpr int bigSquareSize = 32 * tileScale;
	static constexpr int NUM_SPLAT_DETAIL_NORMALS = 4;

	// globals for SMFGround{Drawer, Textures}
	int numBigTexX;
	int numBigTexY;
	int bigTexSize;
	int tileMapSizeX;
	int tileMapSizeY;
	int tileCount;
	int mapSizeX;
	int mapSizeZ;
	int maxHeightMapIdx;
	int heightMapSizeX;

private:
	void ParseHeader();
	void LoadHeightMap();
	void LoadMinimap();
	void InitializeWaterHeightColors();
	void CreateSpecularTex();
	void CreateSplatDetailTextures();
	void CreateGrassTex();
	void CreateDetailTex();
	void CreateShadingTex();
	void CreateNormalTex();

	void UpdateVertexNormalsUnsynced(const SRectangle& update);
	void UpdateFaceNormalsUnsynced(const SRectangle& update);
	void UpdateNormalTexture(const SRectangle& update);
	void UpdateShadingTexture(const SRectangle& update);

	inline const float GetCenterHeightUnsynced(const int x, const int y) const;

	void ParseSMD(std::string filename);

private:
	// note: intentionally declared static (see ReadMap)
	static CSMFMapFile mapFile;

	static std::vector<float> cornerHeightMapSynced;
	static std::vector<float> cornerHeightMapUnsynced;

	static std::vector<unsigned char> shadingTexBuffer;
	static std::vector<unsigned char> waterHeightColors;

private:
	bool haveSpecularTexture           = false;
	bool haveSplatDetailDistribTexture = false;
	bool haveSplatNormalDistribTexture = false;
};

#endif
