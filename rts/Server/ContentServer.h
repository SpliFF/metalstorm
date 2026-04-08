// ContentServer — serves game assets via HTTP.
//
// Scans the game content directory for models and textures,
// builds a JSON manifest, and serves files via HTTP endpoints
// registered on the NetworkServer.
//
// Endpoints:
//   GET /api/content/manifest     — JSON manifest of all assets
//   GET /api/content/assets/...   — individual asset files
#pragma once

#include <string>
#include <vector>
#include <unordered_map>

class NetworkServer;

struct AssetEntry {
    std::string path;        // relative path from content root
    std::string contentType; // MIME type
    size_t size = 0;
};

class ContentServer {
public:
    /// Scan content directories and register HTTP endpoints.
    void Init(NetworkServer& net, const std::vector<std::string>& contentRoots);

private:
    /// Scan a directory tree for servable assets.
    void ScanDirectory(const std::string& root);

    /// Build the JSON manifest.
    std::string BuildManifest() const;

    /// Determine MIME type from file extension.
    static std::string MimeType(const std::string& ext);

    std::unordered_map<std::string, AssetEntry> assets; // key = url path
    std::vector<std::string> roots;
    std::string cachedManifest;
};
