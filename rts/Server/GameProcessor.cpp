// GameProcessor — see header for pipeline overview.

#include "GameProcessor.h"
#include "System/SpringLog/SpringLog.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <system_error>

#define LOG_SECTION "game-proc"

// Absolute path to the modelimporter binary, injected at build time
// via target_compile_definitions in the top-level CMakeLists. Falls
// back to a bare name for source-tree-relative invocations where
// the binary happens to be on $PATH.
#ifndef MODELIMPORTER_BINARY_PATH
#define MODELIMPORTER_BINARY_PATH "modelimporter"
#endif

namespace fs = std::filesystem;

namespace {

std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return std::tolower(c); });
    return s;
}

/// Run a shell command, capturing combined stdout+stderr. Returns the
/// exit code; captured output is logged on non-zero return.
int RunCommand(const std::string& cmd) {
    FILE* p = popen(cmd.c_str(), "r");
    if (!p) return -1;
    char buf[256];
    std::string out;
    while (fgets(buf, sizeof(buf), p)) out += buf;
    int rc = pclose(p);
    if (rc != 0) {
        SLOG(SPRING_LOG_ERROR, "command failed (%d): %s  %s",
            rc, cmd.c_str(), out.c_str());
    }
    return rc;
}

/// Read the diffuse texture basename out of an S3O header without
/// parsing the rest of the file. Returns empty string for non-S3O
/// files or headers with a zero tex1 offset.
std::string ReadS3OTexture1(const std::string& s3oPath) {
    FILE* f = std::fopen(s3oPath.c_str(), "rb");
    if (!f) return {};
    char header[52];
    if (std::fread(header, 1, sizeof(header), f) != sizeof(header)) {
        std::fclose(f);
        return {};
    }
    if (std::memcmp(header, "Spring unit", 11) != 0) {
        std::fclose(f);
        return {};
    }
    uint32_t tex1Off;
    std::memcpy(&tex1Off, header + 44, 4);
    if (tex1Off == 0) { std::fclose(f); return {}; }
    if (std::fseek(f, tex1Off, SEEK_SET) != 0) { std::fclose(f); return {}; }
    char buf[256] = {0};
    std::fread(buf, 1, sizeof(buf) - 1, f);
    std::fclose(f);
    return std::string(buf);
}

/// Locate a texture file inside `unittexturesDir`, trying an exact
/// match first and falling back to a case-insensitive scan (many
/// Spring games capitalise inconsistently between def and disk).
std::string ResolveTexturePath(const fs::path& unittexturesDir,
                               const std::string& basename) {
    if (basename.empty() || !fs::is_directory(unittexturesDir)) return {};
    const fs::path direct = unittexturesDir / basename;
    if (fs::exists(direct)) return direct.string();
    const std::string wantLower = toLower(basename);
    for (auto& entry : fs::directory_iterator(unittexturesDir)) {
        if (!entry.is_regular_file()) continue;
        if (toLower(entry.path().filename().string()) == wantLower)
            return entry.path().string();
    }
    return {};
}

/// Gate on file extension to avoid spawning a process for stray
/// `.txt`/`.dds`/etc. files that end up in an objects3d/ directory.
/// Assimp itself supports a wider list internally but these are the
/// formats we actually expect to see in a Spring game archive.
bool IsModelExtension(const std::string& ext) {
    static const char* const kExts[] = {
        ".s3o", ".3do",
        ".obj", ".fbx", ".dae", ".gltf", ".glb",
        ".blend", ".3ds", ".ase", ".lwo", ".lws",
        ".stl", ".ply", ".x", ".ms3d",
        ".md2", ".md3", ".md5mesh",
        ".b3d", ".q3o", ".q3s", ".smd", ".vta",
    };
    const std::string lower = toLower(ext);
    for (const char* e : kExts) {
        if (lower == e) return true;
    }
    return false;
}

/// Case-insensitive lookup of a subdirectory — different Spring games
/// spell it "objects3d", "Objects3d", "OBJECTS3D" etc. and we want
/// to find it regardless of the filesystem's case sensitivity.
fs::path FindSubdirectory(const fs::path& parent, const std::string& what) {
    if (!fs::is_directory(parent)) return {};
    const std::string wantLower = toLower(what);
    for (auto& entry : fs::directory_iterator(parent)) {
        if (!entry.is_directory()) continue;
        if (toLower(entry.path().filename().string()) == wantLower)
            return entry.path();
    }
    return {};
}

} // namespace

namespace GameProcessor {

void Process(const std::string& gamePath,
             const std::string& gameId,
             const std::string& dataDir)
{
    const fs::path gameRoot = gamePath;
    const fs::path objectsDir = FindSubdirectory(gameRoot, "objects3d");
    if (objectsDir.empty()) {
        // Not an error — a minimal game (Paper Tanks right now) may
        // ship no model files at all. The log line is still useful
        // so it's obvious why no .config.json files got written.
        SLOG(SPRING_LOG_INFO, "%s: no objects3d/ directory under %s, "
            "nothing to convert",
            gameId.c_str(), gamePath.c_str());
        return;
    }

    const fs::path unittexturesDir = FindSubdirectory(gameRoot, "unittextures");
    const fs::path outDir = fs::path(dataDir) / "games" / gameId / "models";
    std::error_code ec;
    fs::create_directories(outDir, ec);
    if (ec) {
        SLOG(SPRING_LOG_ERROR, "%s: failed to create %s: %s",
            gameId.c_str(), outDir.string().c_str(), ec.message().c_str());
        return;
    }

    int converted = 0;
    int uptodate = 0;
    int skipped = 0;
    int failed = 0;

    for (auto& entry : fs::recursive_directory_iterator(objectsDir)) {
        if (!entry.is_regular_file()) continue;
        const fs::path& src = entry.path();
        if (!IsModelExtension(src.extension().string())) {
            ++skipped;
            continue;
        }

        const std::string stem = src.stem().string();
        const fs::path dstGlb     = outDir / (stem + ".glb");
        const fs::path dstJson    = outDir / (stem + ".config.json");
        const fs::path dstLua     = outDir / (stem + ".config.lua");
        const bool     hasConfig  = fs::exists(dstJson) || fs::exists(dstLua);

        // Idempotent skip: regenerate only when the glb is missing
        // or older than the source. The config file's mtime is
        // deliberately NOT part of this comparison — once the
        // config exists on disk it's author-owned and modelimporter
        // will refuse to touch it without --update-meta, so
        // including it here would cause an infinite rebuild loop
        // whenever the source is newer than a preserved-on-purpose
        // config file. If the config is missing we still need to
        // rebuild so that modelimporter has a chance to write a
        // fresh .config.json.
        bool needsRebuild = true;
        if (fs::exists(dstGlb) && hasConfig) {
            const auto srcMt = fs::last_write_time(src);
            const auto glbMt = fs::last_write_time(dstGlb);
            if (srcMt <= glbMt) {
                needsRebuild = false;
            }
        }

        // Texture: only s3o stores a tex1 basename we can resolve from
        // the game's unittextures/ dir. Assimp-supported formats
        // either embed textures in the source file or reference them
        // by path, which modelimporter handles internally.
        std::string convertedTextureName;
        if (toLower(src.extension().string()) == ".s3o") {
            const std::string texBasename = ReadS3OTexture1(src.string());
            if (!texBasename.empty()) {
                const std::string srcTex =
                    ResolveTexturePath(unittexturesDir, texBasename);
                if (!srcTex.empty()) {
                    const std::string texStem = fs::path(texBasename).stem().string();
                    convertedTextureName = texStem + ".png";
                    const fs::path dstTex = outDir / convertedTextureName;
                    if (!fs::exists(dstTex) ||
                        fs::last_write_time(srcTex) > fs::last_write_time(dstTex)) {
                        const std::string cmd = "magick \"" + srcTex + "\" \"" +
                                                dstTex.string() + "\" 2>&1";
                        if (RunCommand(cmd) != 0) {
                            convertedTextureName.clear();
                        }
                    }
                } else {
                    SLOG(SPRING_LOG_WARNING, "%s: texture '%s' for %s not found "
                        "in unittextures/",
                        gameId.c_str(), texBasename.c_str(),
                        src.filename().string().c_str());
                }
            }
        }

        if (!needsRebuild) {
            ++uptodate;
            continue;
        }

        std::string cmd = std::string("\"") + MODELIMPORTER_BINARY_PATH + "\"";
        if (!convertedTextureName.empty()) {
            cmd += " --texture-ext png";
        }
        cmd += " \"" + src.string() + "\" \"" + dstGlb.string() + "\" 2>&1";
        if (RunCommand(cmd) != 0) {
            SLOG(SPRING_LOG_ERROR, "%s: modelimporter failed on %s",
                gameId.c_str(), src.filename().string().c_str());
            ++failed;
            continue;
        }
        ++converted;
    }

    SLOG(SPRING_LOG_INFO, "%s: %d converted, %d up-to-date, %d failed, "
        "%d non-model skipped (output: %s)",
        gameId.c_str(), converted, uptodate, failed, skipped,
        outDir.string().c_str());
}

} // namespace GameProcessor
