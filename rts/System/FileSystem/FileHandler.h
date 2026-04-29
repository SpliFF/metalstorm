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
 *
 * Lookups are case-insensitive against an index built at AddContentRoot()
 * time for Mod/Map/Base roots — see FileHandler.cpp for the rationale.
 * Raw roots (cwd) are not indexed.
 */
#pragma once

#include <fstream>
#include <string>
#include <unordered_map>
#include <vector>

#include "VFSModes.h"

class CFileHandler {
public:
    // --- Content root management (static, global) ---

    struct ContentRoot {
        std::string path;      // Absolute path with trailing separator
        RootCategory category;
        // Lowercased relative path → actual relative path as it exists on
        // disk. Empty for Raw roots (which are not indexed).
        std::unordered_map<std::string, std::string> nameIndex;
    };

    /// Add a directory to search when opening files. Mod/Map/Base roots
    /// are recursively scanned to build a case-insensitive name index;
    /// Raw roots are not indexed.
    static void AddContentRoot(const std::string& path,
                               RootCategory cat = RootCategory::Raw);

    /// Clear all content roots.
    static void ClearContentRoots();

    /// Get the current content roots (paths only, for compatibility).
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

    /// List files in a directory matching a glob pattern (case-insensitive).
    static std::vector<std::string> DirList(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& modes = "");

    /// List subdirectories matching a glob pattern (case-insensitive).
    static std::vector<std::string> SubDirs(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& modes = "");

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

    /// Get the root paths that match the given mode string. Always
    /// includes Base roots as a fallback (mirrors springcontent.sdz
    /// being an implicit dep on every game in original Spring).
    static std::vector<std::string> GetRootsForModes(const std::string& modes);

    /// Resolve a relative path against indexed content roots
    /// (case-insensitive) followed by direct fs::exists for Raw/PWD
    /// roots. Returns the empty string if nothing matches.
    static std::string ResolvePath(const std::string& filename,
                                   const std::string& modes = "");

    /// Recursively scan `root.path` and populate `root.nameIndex`.
    /// Called from AddContentRoot for Mod/Map/Base roots.
    static void BuildNameIndex(ContentRoot& root);

    std::string name;
    std::string openModes;
    std::string resolvedPath;
    std::ifstream stream;
    bool valid = false;

    static std::vector<ContentRoot> categorizedRoots;
};
