// ContentServer — serves game assets via HTTP.

#include "ContentServer.h"
#include "NetworkServer.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "content"

#include <cstdio>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;

namespace {
// True if an asset key contains a path-traversal attempt: a ".." path segment,
// an absolute path, or a Windows drive/backslash escape. Checks segments so a
// legitimate filename merely *containing* ".." (e.g. "a..b.glb") is allowed.
bool HasTraversal(const std::string& key) {
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
} // namespace

void ContentServer::Init(NetworkServer& net, const std::vector<std::string>& contentRoots) {
    roots = contentRoots;

    for (const auto& root : roots) {
        if (fs::exists(root) && fs::is_directory(root))
            ScanDirectory(root);
    }

    cachedManifest = BuildManifest();
    SLOG(SPRING_LOG_INFO, "scanned %zu assets from %zu roots",
        assets.size(), roots.size());

    // Manifest endpoint
    net.AddHttpGet("/api/content/manifest", RouteAuth::Public, [this](const std::string&) -> HttpResponse {
        std::vector<uint8_t> body(cachedManifest.begin(), cachedManifest.end());
        return {.contentType = "application/json", .body = std::move(body), .status = 200};
    });

    // Asset file endpoint (pattern matches /api/content/assets/*)
    net.AddHttpGet("/api/content/assets/*", RouteAuth::Public, [this](const std::string& url) -> HttpResponse {
        // Strip prefix to get the asset key
        const std::string prefix = "/api/content/assets/";
        if (url.size() <= prefix.size())
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::string key = url.substr(prefix.size());

        // S7: reject path-traversal keys explicitly. The lookup below is
        // manifest-bound (only scanned assets resolve), but the file read
        // joins `key`-derived paths against each root, so defend in depth —
        // a `..` segment or absolute/leading-slash key must never be served.
        // (Percent-decoding happens upstream in NetworkServer, so by here a
        // traversal attempt appears as literal ".." segments.)
        if (HasTraversal(key))
            return {.contentType = "text/plain", .body = {}, .status = 403};

        auto it = assets.find(key);
        if (it == assets.end())
            return {.contentType = "text/plain", .body = {}, .status = 404};

        // Read the file from disk
        const auto& entry = it->second;
        std::string fullPath;
        for (const auto& root : roots) {
            auto candidate = fs::path(root) / entry.path;
            if (fs::exists(candidate)) {
                fullPath = candidate.string();
                break;
            }
        }
        if (fullPath.empty())
            return {.contentType = "text/plain", .body = {}, .status = 404};

        std::ifstream file(fullPath, std::ios::binary);
        if (!file.is_open())
            return {.contentType = "text/plain", .body = {}, .status = 500};

        std::vector<uint8_t> body(
            (std::istreambuf_iterator<char>(file)),
            std::istreambuf_iterator<char>());

        return {.contentType = entry.contentType, .body = std::move(body), .status = 200};
    });
}

void ContentServer::ScanDirectory(const std::string& root) {
    static const std::vector<std::string> SERVABLE_EXTS = {
        ".s3o", ".3do", ".obj", ".gltf", ".glb",   // models
        ".png", ".jpg", ".jpeg", ".dds", ".ktx2",   // textures
        ".wav", ".ogg", ".webm", ".m4a", ".mp3",   // audio
        ".lua",                                       // scripts
        ".json",                                      // metadata
    };

    for (auto& entry : fs::recursive_directory_iterator(root)) {
        if (!entry.is_regular_file()) continue;

        std::string ext = entry.path().extension().string();
        // Lowercase the extension
        for (auto& c : ext) c = static_cast<char>(std::tolower(c));

        bool servable = false;
        for (const auto& sext : SERVABLE_EXTS) {
            if (ext == sext) { servable = true; break; }
        }
        if (!servable) continue;

        // Relative path from root
        std::string relPath = fs::relative(entry.path(), root).string();
        // Normalize path separators
        for (auto& c : relPath) { if (c == '\\') c = '/'; }

        AssetEntry asset;
        asset.path = relPath;
        asset.contentType = MimeType(ext);
        asset.size = entry.file_size();

        // Key is the relative path (used in URL)
        assets[relPath] = std::move(asset);
    }
}

std::string ContentServer::BuildManifest() const {
    std::string json = "{\"assets\":[";
    bool first = true;
    for (const auto& [key, entry] : assets) {
        if (!first) json += ",";
        first = false;
        json += "{\"path\":\"";
        json += key;
        json += "\",\"type\":\"";
        json += entry.contentType;
        json += "\",\"size\":";
        json += std::to_string(entry.size);
        json += "}";
    }
    json += "]}";
    return json;
}

std::string ContentServer::MimeType(const std::string& ext) {
    if (ext == ".glb" || ext == ".gltf") return "model/gltf-binary";
    if (ext == ".s3o" || ext == ".3do" || ext == ".obj") return "application/octet-stream";
    if (ext == ".png") return "image/png";
    if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
    if (ext == ".dds") return "image/vnd-ms.dds";
    if (ext == ".ktx2") return "image/ktx2";
    if (ext == ".lua") return "text/x-lua";
    if (ext == ".json") return "application/json";
    if (ext == ".wav") return "audio/wav";
    if (ext == ".ogg") return "audio/ogg";
    if (ext == ".webm") return "audio/webm";
    if (ext == ".m4a") return "audio/mp4";
    if (ext == ".mp3") return "audio/mpeg";
    return "application/octet-stream";
}
