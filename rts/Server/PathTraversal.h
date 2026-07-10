#pragma once

#include <string>

// True if `key` contains a path-traversal attempt: a ".." path segment, an
// absolute path, or a Windows drive/backslash escape. Checks path segments so
// a legitimate filename merely *containing* ".." (e.g. "a..b.glb") is allowed.
inline bool HasPathTraversal(const std::string& key) {
    if (key.empty()) return true;
    if (key.front() == '/' || key.front() == '\\') return true;   // absolute
    size_t start = 0;
    for (size_t i = 0; i <= key.size(); ++i) {
        if (i == key.size() || key[i] == '/' || key[i] == '\\') {
            const std::string seg = key.substr(start, i - start);
            if (seg == "..") return true;
            start = i + 1;
        }
    }
    return false;
}
