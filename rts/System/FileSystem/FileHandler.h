/**
 * CFileHandler — reads files from categorized content directories.
 *
 * Content roots are registered with a RootCategory (Mod, Map, Base, Raw).
 * When opening files, the mode string controls which categories are searched:
 *   'm'/'z' → Mod roots only
 *   'a'     → Map roots only
 *   's'     → Base roots only
 *   'r'     → All roots
 * Mode strings are iterated char-by-char; first match wins.
 */
#pragma once

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "VFSModes.h"

class CFileHandler {
public:
    // --- Content root management (static, global) ---

    struct ContentRoot {
        std::string path;      // Absolute path with trailing separator
        RootCategory category;
    };

    /// Add a directory to search when opening files.
    /// Roots are searched in the order they were added, filtered by mode.
    static void AddContentRoot(const std::string& path, RootCategory cat = RootCategory::Raw) {
        auto abs = std::filesystem::absolute(path).string();
        if (!abs.empty() && abs.back() != '/')
            abs += '/';
        categorizedRoots.push_back({abs, cat});
    }

    /// Clear all content roots.
    static void ClearContentRoots() {
        categorizedRoots.clear();
    }

    /// Get the current content roots (for compatibility).
    static std::vector<std::string> GetContentRoots() {
        std::vector<std::string> result;
        result.reserve(categorizedRoots.size());
        for (const auto& r : categorizedRoots)
            result.push_back(r.path);
        return result;
    }

    /// Get the categorized content roots.
    static const std::vector<ContentRoot>& GetCategorizedRoots() {
        return categorizedRoots;
    }

    // --- Instance API ---

    CFileHandler(const std::string& filename, const std::string& modes = "")
        : name(filename), openModes(modes)
    {
        OpenInternal(filename, modes);
    }

    CFileHandler(const char* filename, const char* modes = "")
        : name(filename), openModes(modes ? modes : "")
    {
        OpenInternal(filename, openModes);
    }

    void Open(const std::string& filename, const std::string& modes = "") {
        name = filename;
        openModes = modes;
        stream.close();
        valid = false;
        OpenInternal(filename, modes);
    }

    void Close() {
        stream.close();
        valid = false;
        name.clear();
    }

    bool FileExists() const { return valid; }

    int FileSize() const {
        if (!valid) return -1;
        auto& s = const_cast<std::ifstream&>(stream);
        auto pos = s.tellg();
        s.seekg(0, std::ios::end);
        int size = static_cast<int>(s.tellg());
        s.seekg(pos);
        return size;
    }

    int Read(void* buf, int length) {
        if (!valid) return 0;
        stream.read(static_cast<char*>(buf), length);
        return static_cast<int>(stream.gcount());
    }

    int ReadString(void* buf, int length) {
        return Read(buf, length);
    }

    void Seek(int pos, std::ios_base::seekdir dir = std::ios::beg) {
        if (valid) stream.seekg(pos, dir);
    }

    int GetPos() {
        if (!valid) return -1;
        return static_cast<int>(stream.tellg());
    }

    bool Eof() const {
        return !valid || const_cast<std::ifstream&>(stream).peek() == EOF;
    }

    const std::string& GetName() const { return name; }

    bool IsBuffered() const { return false; }
    std::vector<unsigned char> GetBuffer() { return {}; }

    bool LoadStringData(std::string& data) {
        if (!valid) return false;
        const int sz = FileSize();
        if (sz < 0) return false;
        data.resize(sz);
        Seek(0);
        stream.read(&data[0], sz);
        return stream.gcount() == sz;
    }

    // --- Static file operations ---

    static bool FileExists(const std::string& filename, const std::string& modes = "") {
        return !ResolvePath(filename, modes).empty();
    }
    static bool FileExists(const std::string& filename, const char* modes) {
        return !ResolvePath(filename, modes ? modes : "").empty();
    }

    /// List files in a directory matching a glob pattern.
    static std::vector<std::string> DirList(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& modes = "")
    {
        std::vector<std::string> result;
        namespace fs = std::filesystem;

        auto roots = GetRootsForModes(modes);
        for (const auto& root : roots) {
            fs::path dirPath = fs::path(root) / dir;
            if (!fs::is_directory(dirPath))
                continue;

            for (const auto& entry : fs::directory_iterator(dirPath)) {
                if (!entry.is_regular_file())
                    continue;

                std::string fname = entry.path().filename().string();
                if (MatchGlob(fname, pattern)) {
                    std::string relPath = dir;
                    if (!relPath.empty() && relPath.back() != '/')
                        relPath += '/';
                    relPath += fname;
                    result.push_back(relPath);
                }
            }
        }

        std::sort(result.begin(), result.end());
        result.erase(std::unique(result.begin(), result.end()), result.end());
        return result;
    }

    /// List subdirectories matching a glob pattern.
    static std::vector<std::string> SubDirs(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& modes = "")
    {
        std::vector<std::string> result;
        namespace fs = std::filesystem;

        auto roots = GetRootsForModes(modes);
        for (const auto& root : roots) {
            fs::path dirPath = fs::path(root) / dir;
            if (!fs::is_directory(dirPath))
                continue;

            for (const auto& entry : fs::directory_iterator(dirPath)) {
                if (!entry.is_directory())
                    continue;

                std::string dname = entry.path().filename().string();
                if (MatchGlob(dname, pattern)) {
                    std::string relPath = dir;
                    if (!relPath.empty() && relPath.back() != '/')
                        relPath += '/';
                    relPath += dname + '/';
                    result.push_back(relPath);
                }
            }
        }

        std::sort(result.begin(), result.end());
        result.erase(std::unique(result.begin(), result.end()), result.end());
        return result;
    }

    // --- Mode filters ---
    static std::string AllowModes(const std::string& modes, const std::string& allowed) {
        std::string result;
        for (char c : modes)
            if (allowed.find(c) != std::string::npos)
                result += c;
        return result;
    }
    static std::string AllowModes(const char* modes, const char* allowed) {
        return AllowModes(std::string(modes ? modes : ""), std::string(allowed ? allowed : ""));
    }
    static std::string ForbidModes(const char* modes, const char* forbidden) {
        return ForbidModes(std::string(modes ? modes : ""), std::string(forbidden ? forbidden : ""));
    }
    static std::string ForbidModes(const std::string& modes, const std::string& forbidden) {
        std::string result;
        for (char c : modes)
            if (forbidden.find(c) == std::string::npos)
                result += c;
        return result;
    }

    static std::string GetFileAbsolutePath(const std::string& f, const std::string& modes = "") {
        std::string resolved = ResolvePath(f, modes);
        return resolved.empty() ? f : resolved;
    }
    static std::string GetArchiveContainingFile(const std::string&, const std::string& = "") { return ""; }
    static std::string GetArchiveContainingFile(const std::string&, const char*) { return ""; }

private:
    void OpenInternal(const std::string& filename, const std::string& modes) {
        std::string resolved = ResolvePath(filename, modes);
        if (!resolved.empty()) {
            stream.open(resolved, std::ios::binary);
            valid = stream.good();
            if (valid)
                resolvedPath = resolved;
        } else {
            valid = false;
        }
    }

    /// Get the root paths that match the given mode string.
    /// If modes is empty, returns all roots (backwards compat).
    ///
    /// Base roots (cont/base/springcontent/) are always appended as a fallback,
    /// mirroring original Spring where springcontent.sdz was an
    /// implicit dependency of every game.
    static std::vector<std::string> GetRootsForModes(const std::string& modes) {
        std::vector<std::string> result;

        if (modes.empty()) {
            // No modes specified — search all roots
            for (const auto& r : categorizedRoots)
                result.push_back(r.path);
            return result;
        }

        bool hasAllRoots = false;
        bool hasBase = false;

        // Iterate mode chars, collect matching roots in order
        for (char c : modes) {
            int cat = GetRootCategoryForMode(c);
            if (cat == -2) {
                // RAW — add all roots
                hasAllRoots = true;
                for (const auto& r : categorizedRoots)
                    result.push_back(r.path);
            } else if (cat == -3) {
                // PWD — add cwd
                result.push_back(std::filesystem::current_path().string() + "/");
            } else if (cat >= 0) {
                auto rc = static_cast<RootCategory>(cat);
                if (rc == RootCategory::Base)
                    hasBase = true;
                for (const auto& r : categorizedRoots) {
                    if (r.category == rc)
                        result.push_back(r.path);
                }
            }
            // cat == -1: unknown mode char, skip
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

    /// Try to find a file by searching content roots filtered by mode.
    static std::string ResolvePath(const std::string& filename, const std::string& modes = "") {
        namespace fs = std::filesystem;

        // If the path is already absolute and exists, use it directly
        if (fs::path(filename).is_absolute()) {
            if (fs::exists(filename))
                return filename;
            return "";
        }

        // Get roots matching the requested modes
        auto roots = GetRootsForModes(modes);

        // Search roots in order
        for (const auto& root : roots) {
            std::string candidate = root + filename;
            if (fs::exists(candidate))
                return candidate;
        }

        // Fall back to cwd if no modes specified
        if (modes.empty() && fs::exists(filename))
            return fs::absolute(filename).string();

        return "";
    }

    /// Simple glob matching (supports * and ? only).
    static bool MatchGlob(const std::string& str, const std::string& pattern) {
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

    std::string name;
    std::string openModes;
    std::string resolvedPath;
    std::ifstream stream;
    bool valid = false;

    static inline std::vector<ContentRoot> categorizedRoots;
};
