/**
 * CFileHandler — content-root resolution with case-insensitive lookup.
 *
 * Original Spring's VFS layer (IArchive::FindFile) lowercased every
 * lookup key against an index built at archive-scan time, so game
 * scripts could include `gamedata/UnitDefs.lua` even though the
 * on-disk file was `gamedata/unitdefs.lua`. When the archive system
 * was deleted in Phase 0 the new CFileHandler used raw `fs::exists`
 * and silently inherited the host filesystem's case rules — which
 * works on macOS (APFS, case-insensitive by default) but breaks on
 * Linux production hosts.
 *
 * This file restores the original behaviour by indexing every
 * Mod/Map/Base content root at AddContentRoot() time: a flat map
 * from lowercased relative path → actual relative path. Lookups
 * lowercase the requested path and consult the index. Raw roots
 * (cwd) are not indexed — they're a fallback for direct paths.
 *
 * Indexes are static and never mutated after init; lookups are
 * lock-free.
 */
#include "FileHandler.h"

#include "System/StringUtil.h"
#include "System/SpringLog/SpringLog.h"

#include <algorithm>
#include <filesystem>

#define LOG_SECTION "vfs"

namespace fs = std::filesystem;

// --- Static state (defined in header as `inline`) ---

void CFileHandler::AddContentRoot(const std::string& path, RootCategory cat)
{
    auto abs = fs::absolute(path).string();
    if (!abs.empty() && abs.back() != '/')
        abs += '/';

    ContentRoot root;
    root.path = abs;
    root.category = cat;

    // Index Mod/Map/Base — but NOT Raw: cwd would mean walking the
    // entire repo (build dirs, .git, node_modules) for no gain.
    if (cat != RootCategory::Raw) {
        BuildNameIndex(root);
        SLOG(SPRING_LOG_INFO, "indexed %zu file(s) under %s",
             root.nameIndex.size(), root.path.c_str());
    }

    categorizedRoots.push_back(std::move(root));
}

void CFileHandler::BuildNameIndex(ContentRoot& root)
{
    if (!fs::is_directory(root.path))
        return;

    std::error_code ec;
    auto it = fs::recursive_directory_iterator(
        root.path,
        fs::directory_options::skip_permission_denied,
        ec);
    if (ec) return;

    const size_t prefixLen = root.path.size();
    for (; it != fs::recursive_directory_iterator(); it.increment(ec)) {
        if (ec) { ec.clear(); continue; }
        if (!it->is_regular_file(ec)) continue;

        const auto& full = it->path().string();
        if (full.size() <= prefixLen) continue;

        std::string rel = full.substr(prefixLen);
        // Normalise path separators to forward slashes (Windows uses \).
        std::replace(rel.begin(), rel.end(), '\\', '/');

        const std::string key = StringToLower(rel);
        // First entry wins — matches the original IArchive behaviour
        // when two files differ only in case.
        root.nameIndex.emplace(key, std::move(rel));
    }
}

void CFileHandler::ClearContentRoots()
{
    categorizedRoots.clear();
}

std::vector<std::string> CFileHandler::GetRootsForModes(const std::string& modes)
{
    std::vector<std::string> result;

    if (modes.empty()) {
        for (const auto& r : categorizedRoots)
            result.push_back(r.path);
        return result;
    }

    bool hasAllRoots = false;
    bool hasBase = false;

    for (char c : modes) {
        int cat = GetRootCategoryForMode(c);
        if (cat == -2) {
            hasAllRoots = true;
            for (const auto& r : categorizedRoots)
                result.push_back(r.path);
        } else if (cat == -3) {
            result.push_back(fs::current_path().string() + "/");
        } else if (cat >= 0) {
            auto rc = static_cast<RootCategory>(cat);
            if (rc == RootCategory::Base)
                hasBase = true;
            for (const auto& r : categorizedRoots) {
                if (r.category == rc)
                    result.push_back(r.path);
            }
        }
    }

    // Always include Base roots — engine base content (LuaGadgets/,
    // gamedata/, etc.) must be available regardless of mode, just as
    // springcontent.sdz was an implicit dep in original Spring.
    if (!hasAllRoots && !hasBase) {
        for (const auto& r : categorizedRoots) {
            if (r.category == RootCategory::Base)
                result.push_back(r.path);
        }
    }

    return result;
}

std::string CFileHandler::ResolvePath(const std::string& filename, const std::string& modes)
{
    // Absolute paths bypass the index entirely.
    if (fs::path(filename).is_absolute()) {
        return fs::exists(filename) ? filename : std::string();
    }

    // Normalise the lookup key once.
    std::string normalized = filename;
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    const std::string key = StringToLower(normalized);

    // Walk roots in the order GetRootsForModes returns them.
    auto rootPaths = GetRootsForModes(modes);
    for (const auto& rootPath : rootPaths) {
        // Find the matching ContentRoot record (the indexed one, if any).
        const ContentRoot* matched = nullptr;
        for (const auto& r : categorizedRoots) {
            if (r.path == rootPath) { matched = &r; break; }
        }

        if (matched && !matched->nameIndex.empty()) {
            auto it = matched->nameIndex.find(key);
            if (it != matched->nameIndex.end())
                return matched->path + it->second;
        } else {
            // Raw root or PWD: fall back to direct fs::exists on the
            // host filesystem (case rules follow the platform).
            std::string candidate = rootPath + normalized;
            if (fs::exists(candidate))
                return candidate;
        }
    }

    // Final fallback for unmoded lookups: cwd.
    if (modes.empty() && fs::exists(normalized))
        return fs::absolute(normalized).string();

    return std::string();
}

// --- Glob matching (supports * and ?) ---

static bool MatchGlob(const std::string& str, const std::string& pattern)
{
    if (pattern == "*") return true;

    size_t si = 0, pi = 0;
    size_t starIdx = std::string::npos, matchIdx = 0;

    while (si < str.size()) {
        if (pi < pattern.size() && (pattern[pi] == '?' || pattern[pi] == str[si])) {
            si++; pi++;
        } else if (pi < pattern.size() && pattern[pi] == '*') {
            starIdx = pi++;
            matchIdx = si;
        } else if (starIdx != std::string::npos) {
            pi = starIdx + 1;
            si = ++matchIdx;
        } else {
            return false;
        }
    }
    while (pi < pattern.size() && pattern[pi] == '*') pi++;
    return pi == pattern.size();
}

std::vector<std::string> CFileHandler::DirList(
    const std::string& dir, const std::string& pattern,
    const std::string& modes, bool recursive)
{
    std::vector<std::string> result;
    const std::string lcPattern = StringToLower(pattern);

    std::string base = dir;
    if (!base.empty() && base.back() != '/')
        base += '/';

    auto roots = GetRootsForModes(modes);
    for (const auto& root : roots) {
        fs::path dirPath = fs::path(root) / dir;
        if (!fs::is_directory(dirPath))
            continue;

        // The glob matches the filename only (Spring semantics), so a
        // recursive "*.lua" still gathers nested files; the subdirectory
        // prefix is preserved in the returned relative path. BAR loads its
        // ~970 unit defs via VFS.DirList('units/', '*.lua', nil, true) where
        // nearly all files live in units/<faction>/ subfolders.
        const auto handleEntry = [&](const fs::directory_entry& entry) {
            if (!entry.is_regular_file())
                return;
            if (!MatchGlob(StringToLower(entry.path().filename().string()), lcPattern))
                return;
            result.push_back(base + fs::relative(entry.path(), dirPath).generic_string());
        };

        if (recursive) {
            for (const auto& entry : fs::recursive_directory_iterator(dirPath))
                handleEntry(entry);
        } else {
            for (const auto& entry : fs::directory_iterator(dirPath))
                handleEntry(entry);
        }
    }

    std::sort(result.begin(), result.end());
    result.erase(std::unique(result.begin(), result.end()), result.end());
    return result;
}

std::vector<std::string> CFileHandler::SubDirs(
    const std::string& dir, const std::string& pattern,
    const std::string& modes)
{
    std::vector<std::string> result;
    const std::string lcPattern = StringToLower(pattern);

    auto roots = GetRootsForModes(modes);
    for (const auto& root : roots) {
        fs::path dirPath = fs::path(root) / dir;
        if (!fs::is_directory(dirPath))
            continue;

        for (const auto& entry : fs::directory_iterator(dirPath)) {
            if (!entry.is_directory())
                continue;

            std::string dname = entry.path().filename().string();
            if (MatchGlob(StringToLower(dname), lcPattern)) {
                std::string relPath = dir;
                if (!relPath.empty() && relPath.back() != '/')
                    relPath += '/';
                relPath += dname + '/';
                result.push_back(std::move(relPath));
            }
        }
    }

    std::sort(result.begin(), result.end());
    result.erase(std::unique(result.begin(), result.end()), result.end());
    return result;
}

// --- Static member definition ---
std::vector<CFileHandler::ContentRoot> CFileHandler::categorizedRoots;
