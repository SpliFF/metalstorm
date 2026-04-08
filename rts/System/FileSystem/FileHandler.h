/**
 * CFileHandler — reads files from plain content directories.
 *
 * Replaces the VFS/archive system. Files are searched for in a list
 * of content root directories (game dir, map dir, base dir) in order.
 * Relative paths are resolved against each root until found.
 */
#pragma once

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

class CFileHandler {
public:
    // --- Content root management (static, global) ---

    /// Add a directory to search when opening files.
    /// Roots are searched in the order they were added.
    static void AddContentRoot(const std::string& path) {
        auto abs = std::filesystem::absolute(path).string();
        // Ensure trailing separator
        if (!abs.empty() && abs.back() != '/')
            abs += '/';
        contentRoots.push_back(abs);
    }

    /// Clear all content roots.
    static void ClearContentRoots() {
        contentRoots.clear();
    }

    /// Get the current content roots.
    static const std::vector<std::string>& GetContentRoots() {
        return contentRoots;
    }

    // --- Instance API ---

    CFileHandler(const std::string& filename, const std::string& modes = "")
        : name(filename)
    {
        OpenInternal(filename);
    }

    void Open(const std::string& filename, const std::string& /*modes*/ = "") {
        name = filename;
        stream.close();
        OpenInternal(filename);
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

    static bool FileExists(const std::string& filename, const std::string& = "") {
        return !ResolvePath(filename).empty();
    }
    static bool FileExists(const std::string& filename, const char* /*modes*/) {
        return !ResolvePath(filename).empty();
    }

    /// List files in a directory matching a glob pattern.
    static std::vector<std::string> DirList(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& /*modes*/ = "")
    {
        std::vector<std::string> result;
        namespace fs = std::filesystem;

        for (const auto& root : contentRoots) {
            fs::path dirPath = fs::path(root) / dir;
            if (!fs::is_directory(dirPath))
                continue;

            for (const auto& entry : fs::directory_iterator(dirPath)) {
                if (!entry.is_regular_file())
                    continue;

                std::string fname = entry.path().filename().string();
                if (MatchGlob(fname, pattern)) {
                    // Return path relative to content root
                    std::string relPath = dir;
                    if (!relPath.empty() && relPath.back() != '/')
                        relPath += '/';
                    relPath += fname;
                    result.push_back(relPath);
                }
            }
        }

        // Deduplicate (first root wins, but list all unique paths)
        std::sort(result.begin(), result.end());
        result.erase(std::unique(result.begin(), result.end()), result.end());
        return result;
    }

    /// List subdirectories matching a glob pattern.
    static std::vector<std::string> SubDirs(
        const std::string& dir, const std::string& pattern = "*",
        const std::string& /*modes*/ = "")
    {
        std::vector<std::string> result;
        namespace fs = std::filesystem;

        for (const auto& root : contentRoots) {
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

    // --- Mode filters (no-ops, VFS compatibility) ---
    static std::string AllowModes(const std::string& modes, const std::string&) { return modes; }
    static std::string AllowModes(const char* modes, const char*) { return modes ? modes : ""; }
    static std::string ForbidModes(const char* modes, const char*) { return modes ? modes : ""; }
    static std::string ForbidModes(const std::string& modes, const std::string&) { return modes; }

    static std::string GetFileAbsolutePath(const std::string& f, const std::string& = "") {
        std::string resolved = ResolvePath(f);
        return resolved.empty() ? f : resolved;
    }
    static std::string GetArchiveContainingFile(const std::string&, const std::string& = "") { return ""; }
    static std::string GetArchiveContainingFile(const std::string&, const char*) { return ""; }

private:
    void OpenInternal(const std::string& filename) {
        std::string resolved = ResolvePath(filename);
        if (!resolved.empty()) {
            stream.open(resolved, std::ios::binary);
            valid = stream.good();
            if (valid)
                resolvedPath = resolved;
        } else {
            valid = false;
        }
    }

    /// Try to find a file by searching content roots.
    /// Returns the absolute path if found, empty string if not.
    static std::string ResolvePath(const std::string& filename) {
        namespace fs = std::filesystem;

        // If the path is already absolute and exists, use it directly
        if (fs::path(filename).is_absolute()) {
            if (fs::exists(filename))
                return filename;
            return "";
        }

        // Search content roots in order
        for (const auto& root : contentRoots) {
            std::string candidate = root + filename;
            if (fs::exists(candidate))
                return candidate;
        }

        // Fall back to cwd
        if (fs::exists(filename))
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
    std::string resolvedPath;
    std::ifstream stream;
    bool valid = false;

    static inline std::vector<std::string> contentRoots;
};
