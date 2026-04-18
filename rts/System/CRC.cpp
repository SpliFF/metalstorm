/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "CRC.h"

// Simple CRC32 implementation replacing the 7z dependency.
// Uses the standard CRC-32 polynomial.

static uint32_t crcTable[256];
static bool tableInitialized = false;

static void BuildCRCTable()
{
	if (tableInitialized) return;
	for (uint32_t i = 0; i < 256; i++) {
		uint32_t crc = i;
		for (int j = 0; j < 8; j++) {
			if (crc & 1)
				crc = (crc >> 1) ^ 0xEDB88320;
			else
				crc >>= 1;
		}
		crcTable[i] = crc;
	}
	tableInitialized = true;
}


CRC::CRC(): crc(0xFFFFFFFF)
{
	BuildCRCTable();
}


uint32_t CRC::GetDigest() const
{
	return crc ^ 0xFFFFFFFF;
}


CRC& CRC::Update(const void* data, size_t size)
{
	const uint8_t* buf = static_cast<const uint8_t*>(data);
	for (size_t i = 0; i < size; i++) {
		crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >> 8);
	}
	return *this;
}


CRC& CRC::Update(uint32_t data)
{
	return Update(&data, sizeof(data));
}


uint32_t CRC::InitTable()
{
	BuildCRCTable();
	return 0;
}


uint32_t CRC::CalcDigest(const void* data, size_t size)
{
	CRC crc;
	crc.Update(data, size);
	return crc.GetDigest();
}
