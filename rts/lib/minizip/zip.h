// Stub — minizip removed (no archive creation on headless server)
#pragma once
#include <cstdint>

typedef void* zipFile;
#define ZIP_OK 0

typedef struct {
	int tm_sec, tm_min, tm_hour;
	int tm_mday, tm_mon, tm_year;
} tm_zip;

typedef struct {
	tm_zip tmz_date;
	unsigned int dosDate;
	unsigned int internal_fa;
	unsigned int external_fa;
} zip_fileinfo;

#define APPEND_STATUS_CREATE 0
#define Z_OK 0
#define Z_DEFLATED 8
#define Z_BEST_COMPRESSION 9

inline zipFile zipOpen(const char*, int) { return nullptr; }
inline int zipOpenNewFileInZip(zipFile, const char*, const zip_fileinfo*, const void*, unsigned, const void*, unsigned, const char*, int, int) { return -1; }
inline int zipWriteInFileInZip(zipFile, const void*, unsigned) { return -1; }
inline int zipCloseFileInZip(zipFile) { return -1; }
inline int zipClose(zipFile, const char*) { return -1; }
