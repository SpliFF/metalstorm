/* VFS mode constants and root category mapping.
 *
 * Mode strings control which content roots are searched for files.
 * Each character in a mode string maps to a root category:
 *   'm' (MOD/GAME) → game content directory
 *   'a' (MAP)      → map content directory
 *   's' (BASE)     → engine base content (cont/base/springcontent)
 *   'r' (RAW)      → all content roots
 *   'z' (ZIP)      → same as MOD (archives are pre-extracted)
 *   'e' (MENU)     → same as MOD (no separate menu content)
 *
 * Mode strings are iterated char-by-char; first match wins.
 * Example: "ms" searches Mod roots first, then Base roots.
 */
#ifndef VFS_MODES_H
#define VFS_MODES_H

// VFS access mode strings — used by CFileHandler and LuaParser.
// Defined as constexpr char arrays so HSTR_PUSH_CSTRING (which uses sizeof)
// gets the correct string length, and the values implicitly convert to const char*.
static constexpr char SPRING_VFS_RAW[]      = "r";
static constexpr char SPRING_VFS_MOD[]      = "m";
static constexpr char SPRING_VFS_MAP[]      = "a";
static constexpr char SPRING_VFS_BASE[]     = "s";
static constexpr char SPRING_VFS_MENU[]     = "e";
static constexpr char SPRING_VFS_ZIP[]      = "z";

// PWD mode — search current working directory only
static constexpr char SPRING_VFS_PWD[]      = "p";

static constexpr char SPRING_VFS_RAW_FIRST[] = "r";
static constexpr char SPRING_VFS_ZIP_FIRST[] = "z";
static constexpr char SPRING_VFS_MOD_BASE[]  = "ms";
static constexpr char SPRING_VFS_MAP_BASE[]  = "as";
static constexpr char SPRING_VFS_ALL[]       = "rmasez";

/// Content root categories for mode-aware file resolution.
enum class RootCategory {
    Mod,   // Game/mod content (game dir, processed models)
    Map,   // Map content (map dir, processed features)
    Base,  // Engine base content (cont/base/springcontent)
    Raw,   // Uncategorized / fallback (cwd, etc.)
};

/// Map a VFS mode character to a root category.
/// Returns -1 if the character is not a valid section mode.
/// 'r' (RAW) means "search all roots" and is handled specially by callers.
inline int GetRootCategoryForMode(char mode) {
    switch (mode) {
        case 'm': return static_cast<int>(RootCategory::Mod);  // MOD/GAME
        case 'z': return static_cast<int>(RootCategory::Mod);  // ZIP → same as MOD (pre-extracted)
        case 'e': return static_cast<int>(RootCategory::Mod);  // MENU → same as MOD
        case 'a': return static_cast<int>(RootCategory::Map);  // MAP
        case 's': return static_cast<int>(RootCategory::Base); // BASE
        case 'r': return -2;                                    // RAW = search all
        case 'p': return -3;                                    // PWD = cwd only
        default:  return -1;                                    // unknown
    }
}

#endif // VFS_MODES_H
