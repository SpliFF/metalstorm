/* Stub — VFS removed. Provides mode constants for compatibility. */
#ifndef VFS_MODES_H
#define VFS_MODES_H

// VFS access mode strings — kept for code that passes them to LuaParser
// and CFileHandler. The server reads files from plain directories.
// Defined as constexpr char arrays so HSTR_PUSH_CSTRING (which uses sizeof)
// gets the correct string length, and the values implicitly convert to const char*.
static constexpr char SPRING_VFS_RAW[]      = "r";
static constexpr char SPRING_VFS_MOD[]      = "m";
static constexpr char SPRING_VFS_MAP[]      = "a";
static constexpr char SPRING_VFS_BASE[]     = "s";
static constexpr char SPRING_VFS_MENU[]     = "e";
static constexpr char SPRING_VFS_ZIP[]      = "z";

static constexpr char SPRING_VFS_RAW_FIRST[] = "r";
static constexpr char SPRING_VFS_ZIP_FIRST[] = "z";
static constexpr char SPRING_VFS_MOD_BASE[]  = "ms";
static constexpr char SPRING_VFS_MAP_BASE[]  = "as";
static constexpr char SPRING_VFS_ALL[]       = "rmasez";

#endif // VFS_MODES_H
