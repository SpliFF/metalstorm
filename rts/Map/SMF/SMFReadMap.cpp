/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include <cstring> // mem{set,cpy}

#include "SMFReadMap.h"
#include "SMFFormat.h"
#include "Map/MapInfo.h"
#include "System/bitops.h"
#include "System/Config/ConfigHandler.h"
#include "System/EventHandler.h"
#include "System/Exceptions.h"
#include "System/FileSystem/FileHandler.h"
#include "System/Threading/ThreadPool.h"
#include "System/SpringMath.h"
#include "System/SafeUtil.h"
#include "System/StringHash.h"

#define SSMF_UNCOMPRESSED_NORMALS 0

using std::max;



CSMFMapFile CSMFReadMap::mapFile;

std::vector<float> CSMFReadMap::cornerHeightMapSynced;
std::vector<float> CSMFReadMap::cornerHeightMapUnsynced;

std::vector<unsigned char> CSMFReadMap::shadingTexBuffer;
std::vector<unsigned char> CSMFReadMap::waterHeightColors;

static std::vector<float> normalPixels;
static std::vector<unsigned char> shadingPixels;



CSMFReadMap::CSMFReadMap(const std::string& mapName): CEventClient("[CSMFReadMap]", 271950, false)
{
	LOG("[CSMFReadMap] Loading SMF");
	eventHandler.AddClient(this);

	mapFile.Close();
	mapFile.Open(mapName);

	haveSpecularTexture = !(mapInfo->smf.specularTexName.empty());
	haveSplatDetailDistribTexture = (!mapInfo->smf.splatDetailTexName.empty() && !mapInfo->smf.splatDistrTexName.empty());
	haveSplatNormalDistribTexture = false;

	for (const std::string& texName: mapInfo->smf.splatDetailNormalTexNames) {
		haveSplatNormalDistribTexture |= !texName.empty();
	}

	// Detail Normal Splatting requires at least one splatDetailNormalTexture and a distribution texture
	haveSplatNormalDistribTexture &= !mapInfo->smf.splatDistrTexName.empty();

	ParseHeader();
	LoadHeightMap();
	CReadMap::Initialize();

	// Rendering-related texture loading removed (headless server)

	mapFile.ReadFeatureInfo();
}



void CSMFReadMap::ParseHeader()
{
	const SMFHeader& header = mapFile.GetHeader();

	mapDims.mapx = header.mapx;
	mapDims.mapy = header.mapy;

	numBigTexX      = (header.mapx / bigSquareSize);
	numBigTexY      = (header.mapy / bigSquareSize);
	bigTexSize      = (SQUARE_SIZE * bigSquareSize);
	tileMapSizeX    = (header.mapx / tileScale);
	tileMapSizeY    = (header.mapy / tileScale);
	tileCount       = (header.mapx * header.mapy) / (tileScale * tileScale);
	mapSizeX        = (header.mapx * SQUARE_SIZE);
	mapSizeZ        = (header.mapy * SQUARE_SIZE);
	maxHeightMapIdx = ((header.mapx + 1) * (header.mapy + 1)) - 1;
	heightMapSizeX  =  (header.mapx + 1);
}


void CSMFReadMap::LoadHeightMap()
{
	const SMFHeader& header = mapFile.GetHeader();

	cornerHeightMapSynced.clear();
	cornerHeightMapSynced.resize((mapDims.mapx + 1) * (mapDims.mapy + 1));
	#ifdef USE_UNSYNCED_HEIGHTMAP
	cornerHeightMapUnsynced.clear();
	cornerHeightMapUnsynced.resize((mapDims.mapx + 1) * (mapDims.mapy + 1));
	#endif

	heightMapSyncedPtr   = &cornerHeightMapSynced;
	heightMapUnsyncedPtr = &cornerHeightMapUnsynced;

	const float minHgt = mapInfo->smf.minHeightOverride ? mapInfo->smf.minHeight : header.minHeight;
	const float maxHgt = mapInfo->smf.maxHeightOverride ? mapInfo->smf.maxHeight : header.maxHeight;

	float* cornerHeightMapSyncedData = cornerHeightMapSynced.data();
	float* cornerHeightMapUnsyncedData = cornerHeightMapUnsynced.data();

	// FIXME:
	//     callchain CReadMap::Initialize --> CReadMap::UpdateHeightMapSynced(0, 0, mapDims.mapx, mapDims.mapy) -->
	//     PushVisibleHeightMapUpdate --> (next UpdateDraw) UpdateHeightMapUnsynced(0, 0, mapDims.mapx, mapDims.mapy)
	//     initializes the UHM a second time
	//     merge them some way so UHM & shadingtex is available from the time readMap got created
	mapFile.ReadHeightmap(cornerHeightMapSyncedData, cornerHeightMapUnsyncedData, minHgt, (maxHgt - minHgt) / 65536.0f);
}


void CSMFReadMap::LoadMinimap()
{
	// rendering removed; no minimap texture on headless server
}


void CSMFReadMap::InitializeWaterHeightColors()
{
	// rendering removed; no water height colors on headless server
	waterHeightColors.clear();
}


void CSMFReadMap::CreateSpecularTex()
{
	// rendering removed; no specular textures on headless server
}

void CSMFReadMap::CreateSplatDetailTextures()
{
	// rendering removed; no splat/detail textures on headless server
}


void CSMFReadMap::CreateGrassTex()
{
	// rendering removed
}


void CSMFReadMap::CreateDetailTex()
{
	// rendering removed
}


void CSMFReadMap::CreateShadingTex()
{
	// rendering removed; keep buffer for potential sim use
	shadingTexBuffer.clear();
	shadingTexBuffer.resize(mapDims.mapx * mapDims.mapy * 4, 0);
}


void CSMFReadMap::CreateNormalTex()
{
	// rendering removed
}



void CSMFReadMap::UpdateHeightMapUnsynced(const SRectangle& update)
{
	UpdateVertexNormalsUnsynced(update);
	UpdateFaceNormalsUnsynced(update);
	// UpdateNormalTexture and UpdateShadingTexture removed (rendering)
}

// Stub out remaining rendering methods
void CSMFReadMap::UpdateNormalTexture(const SRectangle& update) { /* rendering removed */ }
void CSMFReadMap::UpdateShadingTexture(const SRectangle& update) { /* rendering removed */ }

void CSMFReadMap::SunChanged()
{
	// rendering removed; no texture updates needed
}





void CSMFReadMap::UpdateVertexNormalsUnsynced(const SRectangle& update)
{
	#ifdef USE_UNSYNCED_HEIGHTMAP
	const float*  shm = &cornerHeightMapSynced[0];
		  float*  uhm = &cornerHeightMapUnsynced[0];
		  float3* vvn = &visVertexNormals[0];

	const int W = mapDims.mapxp1;
	const int H = mapDims.mapyp1;

	constexpr int SS = SQUARE_SIZE;

	// a heightmap update over (x1, y1) - (x2, y2) implies the
	// normals change over (x1 - 1, y1 - 1) - (x2 + 1, y2 + 1)
	const int minx = std::max(update.x1 - 1,     0);
	const int minz = std::max(update.y1 - 1,     0);
	const int maxx = std::min(update.x2 + 1, W - 1);
	const int maxz = std::min(update.y2 + 1, H - 1);

	for_mt(minz, maxz+1, [&](const int z) {
		for (int x = minx; x <= maxx; x++) {
			const int vIdxTL = (z    ) * W + x;

			const int xOffL = (x >     0)? 1: 0;
			const int xOffR = (x < W - 1)? 1: 0;
			const int zOffT = (z >     0)? 1: 0;
			const int zOffB = (z < H - 1)? 1: 0;

			const float sxm1 = (x - 1) * SS;
			const float sx   =       x * SS;
			const float sxp1 = (x + 1) * SS;

			const float szm1 = (z - 1) * SS;
			const float sz   =       z * SS;
			const float szp1 = (z + 1) * SS;

			const int shxm1 = x - xOffL;
			const int shx   = x;
			const int shxp1 = x + xOffR;

			const int shzm1 = (z - zOffT) * W;
			const int shz   =           z * W;
			const int shzp1 = (z + zOffB) * W;

			// pretend there are 8 incident triangle faces per vertex
			// for each these triangles, calculate the surface normal,
			// then average the 8 normals (this stays closest to the
			// heightmap data)
			// if edge vertex, don't add virtual neighbor normals to vn
			const float3 vmm = float3(sx  ,  shm[shz   + shx  ],  sz  );

			const float3 vtl = float3(sxm1,  shm[shzm1 + shxm1],  szm1) - vmm;
			const float3 vtm = float3(sx  ,  shm[shzm1 + shx  ],  szm1) - vmm;
			const float3 vtr = float3(sxp1,  shm[shzm1 + shxp1],  szm1) - vmm;

			const float3 vml = float3(sxm1,  shm[shz   + shxm1],  sz  ) - vmm;
			const float3 vmr = float3(sxp1,  shm[shz   + shxp1],  sz  ) - vmm;

			const float3 vbl = float3(sxm1,  shm[shzp1 + shxm1],  szp1) - vmm;
			const float3 vbm = float3(sx  ,  shm[shzp1 + shx  ],  szp1) - vmm;
			const float3 vbr = float3(sxp1,  shm[shzp1 + shxp1],  szp1) - vmm;

			float3 vn(0.0f, 0.0f, 0.0f);
			vn += vtm.cross(vtl) * (zOffT & xOffL); assert(vtm.cross(vtl).y >= 0.0f);
			vn += vtr.cross(vtm) * (zOffT        ); assert(vtr.cross(vtm).y >= 0.0f);
			vn += vmr.cross(vtr) * (zOffT & xOffR); assert(vmr.cross(vtr).y >= 0.0f);
			vn += vbr.cross(vmr) * (        xOffR); assert(vbr.cross(vmr).y >= 0.0f);
			vn += vtl.cross(vml) * (        xOffL); assert(vtl.cross(vml).y >= 0.0f);
			vn += vbm.cross(vbr) * (zOffB & xOffR); assert(vbm.cross(vbr).y >= 0.0f);
			vn += vbl.cross(vbm) * (zOffB        ); assert(vbl.cross(vbm).y >= 0.0f);
			vn += vml.cross(vbl) * (zOffB & xOffL); assert(vml.cross(vbl).y >= 0.0f);

			// update the visible vertex/face height/normal
			uhm[vIdxTL] = shm[vIdxTL];
			vvn[vIdxTL] = vn.ANormalize();
		}
	});
	#endif
}


void CSMFReadMap::UpdateFaceNormalsUnsynced(const SRectangle& update)
{
	#ifdef USE_UNSYNCED_HEIGHTMAP
	const float3* sfn = &faceNormalsSynced[0];
	      float3* ufn = &faceNormalsUnsynced[0];
	const float3* scn = &centerNormalsSynced[0];
	      float3* ucn = &centerNormalsUnsynced[0];

	// a heightmap update over (x1, y1) - (x2, y2) implies the
	// normals change over (x1 - 1, y1 - 1) - (x2 + 1, y2 + 1)
	const int minx = std::max(update.x1 - 1,              0);
	const int minz = std::max(update.y1 - 1,              0);
	const int maxx = std::min(update.x2 + 1, mapDims.mapxm1);
	const int maxz = std::min(update.y2 + 1, mapDims.mapym1);

	for (int z = minz; z <= maxz; z++) {
		{
			const int idx0 = (z * mapDims.mapx + minx) * 2    ;
			const int idx1 = (z * mapDims.mapx + maxx) * 2 + 1;
			memcpy(&ufn[idx0], &sfn[idx0], (idx1 - idx0 + 1) * sizeof(float3));
		}
		{
			const int idx0 = (z * mapDims.mapx + minx);
			const int idx1 = (z * mapDims.mapx + maxx);
			memcpy(&ucn[idx0], &scn[idx0], (idx1 - idx0 + 1) * sizeof(float3));
		}
	}
	#endif
}


// Rendering implementations removed (headless server).

#if 0 // removed rendering code — kept for reference only
void CSMFReadMap::UpdateNormalTexture_REMOVED(const SRectangle& update)
{
	// Update VertexNormalsTexture;  texture space is [0 .. mapDims.mapx] x [0 .. mapDims.mapy] (NPOT; vertex-aligned)
	float3* vvn = &visVertexNormals[0];

	// a heightmap update over (x1, y1) - (x2, y2) implies the
	// normals change over (x1 - 1, y1 - 1) - (x2 + 1, y2 + 1)
	const int minx = std::max(update.x1 - 1,            0);
	const int minz = std::max(update.y1 - 1,            0);
	const int maxx = std::min(update.x2 + 1, mapDims.mapx);
	const int maxz = std::min(update.y2 + 1, mapDims.mapy);

	const int xsize = (maxx - minx) + 1;
	const int zsize = (maxz - minz) + 1;

	// Note, it doesn't make sense to use a PBO here.
	// Cause the upstreamed float32s need to be transformed to float16s, which seems to happen on the CPU!

#if (SSMF_UNCOMPRESSED_NORMALS == 1)
	normalPixels.clear();
	normalPixels.resize(xsize * zsize * 4, 0.0f);
#else
	normalPixels.clear();
	normalPixels.resize(xsize * zsize * 2, 0.0f);
#endif

	for (int z = minz; z <= maxz; z++) {
		for (int x = minx; x <= maxx; x++) {
			const float3& vertNormal = vvn[z * mapDims.mapxp1 + x];

		#if (SSMF_UNCOMPRESSED_NORMALS == 1)
			normalPixels[((z - minz) * xsize + (x - minx)) * 4 + 0] = vertNormal.x;
			normalPixels[((z - minz) * xsize + (x - minx)) * 4 + 1] = vertNormal.y;
			normalPixels[((z - minz) * xsize + (x - minx)) * 4 + 2] = vertNormal.z;
			normalPixels[((z - minz) * xsize + (x - minx)) * 4 + 3] = 1.0f;
		#else
			// note: y-coord is regenerated in the shader via "sqrt(1 - x*x - z*z)",
			//   this gives us 2 solutions but we know that the y-coord always points
			//   upwards, so we can reconstruct it in the shader.
			normalPixels[((z - minz) * xsize + (x - minx)) * 2 + 0] = vertNormal.x;
			normalPixels[((z - minz) * xsize + (x - minx)) * 2 + 1] = vertNormal.z;
		#endif
		}
	}

	glBindTexture(GL_TEXTURE_2D, normalsTex.GetID());
#if (SSMF_UNCOMPRESSED_NORMALS == 1)
	glTexSubImage2D(GL_TEXTURE_2D, 0, minx, minz, xsize, zsize, GL_RGBA, GL_FLOAT, &normalPixels[0]);
#else
	glTexSubImage2D(GL_TEXTURE_2D, 0, minx, minz, xsize, zsize, GL_RG, GL_FLOAT, &normalPixels[0]);
#endif
}
#endif // removed rendering code



int CSMFReadMap::GetNumFeatures() { return mapFile.GetNumFeatures(); }
int CSMFReadMap::GetNumFeatureTypes() { return mapFile.GetNumFeatureTypes(); }

void CSMFReadMap::GetFeatureInfo(MapFeatureInfo* f) { mapFile.ReadFeatureInfo(f); }

const char* CSMFReadMap::GetFeatureTypeName(int typeID) { return mapFile.GetFeatureTypeName(typeID); }


unsigned char* CSMFReadMap::GetInfoMap(const char* name, MapBitmapInfo* bmInfo)
{
	mapFile.GetInfoMapSize(name, bmInfo);

	if (bmInfo->width <= 0)
		return nullptr;

	unsigned char* data = new unsigned char[bmInfo->width * bmInfo->height];

	// Bitmap override-texture loading removed (headless server, no CBitmap).
	// Read directly from the map file.
	if (mapFile.ReadInfoMap(name, data))
		return data;

	delete[] data;
	return nullptr;
}


void CSMFReadMap::FreeInfoMap(const char* name, unsigned char* data)
{
	delete[] data;
}


int2 CSMFReadMap::GetPatch(int hmx, int hmz) const
{
	return int2{
		std::clamp(hmx, 0, numBigTexX - 1),
		std::clamp(hmz, 0, numBigTexY - 1)
	};
}
