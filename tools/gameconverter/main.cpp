// gameconverter — prepare a legacy Spring-archive game for use with
// spring-web's lobby + sim.
//
// Four jobs, all safe to re-run:
//
//   1. Write `<game>/game.config.lua` — a minimal wrapper that
//      `VFS.Include`s the legacy `modinfo.lua` at runtime, adds
//      `configVersion = "1"`, and returns the merged table. This
//      describes the *game* itself: name, version, description,
//      dependencies. It runs in the lobby's config environment at
//      discovery time and will eventually also be consumed by the
//      sim boot path.
//
//   2. Write `<game>/lobby.config.lua` — a parallel wrapper around
//      `modoptions.lua`, which is the legacy Spring file that
//      describes per-game *setup options* (the dropdowns / sliders
//      / checkboxes a lobby shows when creating a room). Keeping
//      this separate from game.config.lua preserves Spring's
//      original boundary: modoptions runs before the engine
//      starts, in a lobby-scoped environment with its own API
//      surface. Splitting the files now means a future lobby
//      scripting API can expose lobby-only globals to
//      lobby.config.lua without accidentally leaking them into
//      game.config.lua (which must stay safe to run under the
//      sim-side Lua environment too).
//
//   The converter deliberately does *not* parse or re-serialise
//   the legacy files; the lobby's ConfigReader has a VFS.Include
//   shim that resolves the relative paths at load time, so the
//   one-time cost of "convert" is just writing these two small
//   templates. If the author later modifies modinfo.lua or
//   modoptions.lua the generated wrappers pick up the changes on
//   the next lobby start.
//
//   3. Convert every model file under `<game>/objects3d/`,
//      `<game>/Objects3d/`, etc. to glTF via the modelimporter tool.
//      Output goes under `data/games/<gameId>/models/`, matching
//      what GameProcessor does when the lobby runs end-to-end —
//      the converter exists so authors can pre-bake assets before
//      launching the lobby, and to serve as a reference for
//      integrators who want to run the pipeline out-of-process.
//
//   4. Migrate legacy AI layouts to the `ai/<name>/main.lua` +
//      `ai.config.lua` convention. We handle two shapes:
//
//        ai/<name>.lua        →  ai/<name>/main.lua + ai.config.lua
//        ai/<name>/main.lua   →  add ai.config.lua if missing
//
//      Anything else (LuaAI.lua at the game root, Spring
//      SkirmishAI-style archives with compiled plugins, etc.) is
//      logged as a warning and left alone; those need manual
//      attention and the tool shouldn't pretend otherwise.
//
// All three steps are idempotent: files that already look correct
// are left alone unless `--force` is passed. This means the
// converter is cheap to run from CI or on every lobby startup as a
// pre-flight, and it never destroys hand-authored metadata.

#include "SpringLog.h"
#include "SpringLogNet.h"

#ifndef TEXTURECONVERTER_BINARY_PATH
#define TEXTURECONVERTER_BINARY_PATH "textureconverter"
#endif

#define LOG_SECTION "game-convert"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>
#include <vector>

namespace fs = std::filesystem;

namespace {

// ---------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------

/// Lowercase a string.
std::string ToLower(std::string s) {
    for (auto& c : s)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

/// Case-insensitive file-in-directory lookup. Returns the first
/// child of `dir` whose lowercased filename matches `wantLower`,
/// or an empty path if no match. Legacy Spring archives mix
/// capitalisations (`modinfo.lua` vs `ModInfo.lua`, `ModOptions.lua`
/// vs `modoptions.lua`), so every filename lookup here needs to
/// tolerate both.
fs::path ResolveCaseInsensitive(const fs::path& dir, const std::string& wantLower) {
    if (!fs::exists(dir) || !fs::is_directory(dir))
        return {};
    for (const auto& entry : fs::directory_iterator(dir)) {
        if (ToLower(entry.path().filename().string()) == wantLower)
            return entry.path();
    }
    return {};
}

/// Case-insensitive directory lookup — a subdir of `parent` whose
/// lowercased name matches `wantLower`. Used to find objects3d/
/// under either casing.
fs::path ResolveSubDir(const fs::path& parent, const std::string& wantLower) {
    if (!fs::exists(parent) || !fs::is_directory(parent))
        return {};
    for (const auto& entry : fs::directory_iterator(parent)) {
        if (!entry.is_directory()) continue;
        if (ToLower(entry.path().filename().string()) == wantLower)
            return entry.path();
    }
    return {};
}

/// Write `text` to `path`, creating parent directories as needed.
/// Logs and returns false on failure.
bool WriteFileText(const fs::path& path, const std::string& text) {
    std::error_code ec;
    fs::create_directories(path.parent_path(), ec);
    std::ofstream f(path);
    if (!f.is_open()) {
        SLOG(SPRING_LOG_ERROR, "failed to open %s for writing",
            path.string().c_str());
        return false;
    }
    f << text;
    return true;
}

/// Run a command with arguments via fork/execvp-equivalent popen.
/// Returns true if the command exited with status 0. stdout/stderr
/// of the child are captured into `output` for logging on failure.
bool RunCommand(const std::vector<std::string>& argv, std::string& output) {
    // Build a single shell-safe command string. We use popen because
    // the tool already shells out to modelimporter elsewhere in the
    // project and adding a proper exec wrapper here would be
    // overkill for a preprocess-time utility.
    std::string cmd;
    for (size_t i = 0; i < argv.size(); ++i) {
        if (i) cmd += ' ';
        cmd += '"';
        for (char c : argv[i]) {
            if (c == '"' || c == '\\') cmd += '\\';
            cmd += c;
        }
        cmd += '"';
    }
    cmd += " 2>&1";

    FILE* pipe = popen(cmd.c_str(), "r");
    if (!pipe) {
        output = "popen failed";
        return false;
    }
    char buf[512];
    while (fgets(buf, sizeof(buf), pipe) != nullptr) {
        output += buf;
    }
    int status = pclose(pipe);
    return status == 0;
}

// ---------------------------------------------------------------
// Step 1: game.config.lua wrapper (game metadata)
// ---------------------------------------------------------------
//
// Runs in the lobby's config environment at discovery time and
// (eventually) in the sim's config environment at game-boot time.
// Keeping this file free of lobby-only globals means the sim can
// load it too without needing a shim layer.

const char* kGameConfigTemplate =
    "-- Auto-generated by gameconverter.\n"
    "--\n"
    "-- Thin wrapper around the legacy Spring-archive `modinfo.lua`.\n"
    "-- Describes the *game* itself (name, version, dependencies) —\n"
    "-- per-game setup options live in a sibling `lobby.config.lua`\n"
    "-- so the two can be evaluated under different Lua environments\n"
    "-- without cross-contamination.\n"
    "--\n"
    "-- Edit `modinfo.lua` to change the displayed name / version /\n"
    "-- description; this file picks up those changes on the next\n"
    "-- lobby start. Re-run gameconverter only if the template\n"
    "-- itself changes in a future spring-web release.\n"
    "--\n"
    "-- `VFS.Include` is provided by ConfigReader (see\n"
    "-- rts/Server/ConfigReader.cpp) and resolves relative paths\n"
    "-- against this game's archive root.\n"
    "\n"
    "local config = VFS.Include('modinfo.lua') or {}\n"
    "config.configVersion = \"1\"\n"
    "return config\n";

bool ConvertGameConfig(const fs::path& gameDir, bool force) {
    const fs::path modInfo = ResolveCaseInsensitive(gameDir, "modinfo.lua");
    if (modInfo.empty()) {
        SLOG(SPRING_LOG_WARNING, "%s: no modinfo.lua found — skipping game.config.lua",
            gameDir.string().c_str());
        return false;
    }

    const fs::path outPath = gameDir / "game.config.lua";
    if (fs::exists(outPath) && !force) {
        SLOG(SPRING_LOG_INFO, "%s: game.config.lua already exists (use --force to overwrite)",
            gameDir.string().c_str());
        return true;
    }

    if (!WriteFileText(outPath, kGameConfigTemplate))
        return false;

    SLOG(SPRING_LOG_NOTICE, "wrote %s", outPath.string().c_str());
    return true;
}

// ---------------------------------------------------------------
// Step 2: lobby.config.lua wrapper (per-game setup options)
// ---------------------------------------------------------------
//
// Runs only in the lobby environment — the sim never touches this
// file. `modoptions.lua` in a legacy Spring archive is an array of
// option-definition tables (key / name / desc / type / def / min /
// max / items / ...) that a lobby consumes to draw the "set up
// game" UI. Keeping this as a separate config file preserves
// Spring's historical boundary between "game rules the engine
// cares about" and "knobs the lobby offers a player at room-
// creation time". A future lobby scripting API can expose
// lobby-only globals (matchmaking hooks, UI helpers) here without
// any risk of them leaking into the sim environment via
// game.config.lua.
//
// The wrapper returns either an empty options list or whatever
// `modoptions.lua` evaluated to. The `configVersion` field sits
// alongside `options` so the eventual reader has a stable way to
// spot schema drift.

const char* kLobbyConfigTemplate =
    "-- Auto-generated by gameconverter.\n"
    "--\n"
    "-- Thin wrapper around the legacy Spring-archive `modoptions.lua`.\n"
    "-- Describes the *setup options* the lobby should offer when a\n"
    "-- host is creating a room for this game (checkboxes, sliders,\n"
    "-- dropdowns, etc). This file runs ONLY in the lobby config\n"
    "-- environment — not in the sim. If you need to reach engine\n"
    "-- internals, that belongs in `game.config.lua` (or gadgets).\n"
    "--\n"
    "-- Edit `modoptions.lua` to add / remove / retitle options;\n"
    "-- this file picks up those changes on the next lobby start.\n"
    "-- Re-run gameconverter only if the template itself changes\n"
    "-- in a future spring-web release.\n"
    "--\n"
    "-- `VFS.Include` is provided by ConfigReader. Missing files\n"
    "-- return nil, so games without any tunable options produce\n"
    "-- an empty `options` list rather than an error.\n"
    "\n"
    "return {\n"
    "    configVersion = \"1\",\n"
    "    options = VFS.Include('modoptions.lua') or {},\n"
    "}\n";

bool ConvertLobbyConfig(const fs::path& gameDir, bool force) {
    // Unlike game.config.lua, the *source* file modoptions.lua is
    // optional — many games ship without any options. We still
    // write lobby.config.lua even if no modoptions.lua is present,
    // because the lobby has a single code path that reads
    // lobby.config.lua and expects an `options` field. An empty
    // list is a valid, meaningful answer for "this game has no
    // setup options"; requiring the wrapper file to exist avoids
    // the lobby having to distinguish "unauthored" from "no
    // options" at discovery time.
    const fs::path modOptions = ResolveCaseInsensitive(gameDir, "modoptions.lua");
    if (modOptions.empty()) {
        SLOG(SPRING_LOG_INFO, "%s: no modoptions.lua (empty lobby options)",
            gameDir.string().c_str());
    }

    const fs::path outPath = gameDir / "lobby.config.lua";
    if (fs::exists(outPath) && !force) {
        SLOG(SPRING_LOG_INFO, "%s: lobby.config.lua already exists (use --force to overwrite)",
            gameDir.string().c_str());
        return true;
    }

    if (!WriteFileText(outPath, kLobbyConfigTemplate))
        return false;

    SLOG(SPRING_LOG_NOTICE, "wrote %s", outPath.string().c_str());
    return true;
}

// ---------------------------------------------------------------
// Step 3: model + texture conversion
// ---------------------------------------------------------------

/// Case-insensitive texture lookup in a directory.
std::string ResolveTexturePath(const fs::path& dir, const std::string& basename) {
    if (basename.empty() || !fs::is_directory(dir)) return {};
    const fs::path direct = dir / basename;
    if (fs::exists(direct)) return direct.string();
    const std::string wantLower = ToLower(basename);
    for (auto& entry : fs::directory_iterator(dir)) {
        if (!entry.is_regular_file()) continue;
        if (ToLower(entry.path().filename().string()) == wantLower)
            return entry.path().string();
    }
    return {};
}

/// Locate a texture by its stem, scanning every web-unfriendly source
/// extension a Spring archive might use. Order matters: DDS is by far
/// the most common in modern games, the TGA path is the historical
/// 3DO/S3O fallback, and the rest cover hand-authored variants we've
/// seen in zk/. We also tolerate a sibling .png/.jpg/.webp because
/// some authors pre-bake textures and just commit the converted files.
///
/// As a final fallback we strip Assimp's `.NNN` disambiguation
/// suffix (the importer appends `.001`, `.002` to duplicate texture
/// names within a single material). The glb URI ends up with the
/// suffix but the actual file in unittextures/ does not.
std::string ResolveTextureByStem(const fs::path& dir, const std::string& stem) {
    static const char* const kExts[] = {
        ".dds", ".tga", ".bmp", ".png", ".jpg", ".jpeg", ".webp",
    };
    for (const char* ext : kExts) {
        std::string p = ResolveTexturePath(dir, stem + ext);
        if (!p.empty()) return p;
    }

    // Strip a trailing `.NNN` (1–3 digits) and retry — covers
    // `blastwing_tex.001` → `blastwing_tex.dds` and the trickier
    // `cremfactory1.dds.001` → existing-file `cremfactory1.dds`,
    // where the source filename already includes a `.dds` segment
    // before Assimp's de-duplication suffix.
    if (stem.size() >= 5) {
        const size_t dot = stem.rfind('.');
        if (dot != std::string::npos && dot > 0 && dot < stem.size() - 1) {
            const std::string tail = stem.substr(dot + 1);
            bool allDigits = !tail.empty() && tail.size() <= 3;
            for (char c : tail) {
                if (c < '0' || c > '9') { allDigits = false; break; }
            }
            if (allDigits) {
                const std::string base = stem.substr(0, dot);
                // First try `<base>` directly — handles the case
                // where Spring's texture name itself ended in `.dds`
                // and the stripped string is the literal filename.
                std::string p = ResolveTexturePath(dir, base);
                if (!p.empty()) return p;
                for (const char* ext : kExts) {
                    p = ResolveTexturePath(dir, base + ext);
                    if (!p.empty()) return p;
                }
            }
        }
    }
    return {};
}

/// Detect DDS by reading the 4-byte magic. textureconverter has its
/// own copy of this check internally but copies DDS *as-is* — for our
/// browser-delivery use case we need to convert the file to PNG, so
/// we have to detect DDS up front and route to a different tool.
bool IsDdsFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return false;
    char magic[4];
    f.read(magic, 4);
    return f.gcount() == 4 && std::memcmp(magic, "DDS ", 4) == 0;
}

/// Convert a single texture to a web-deliverable PNG sibling of the
/// glb. textureconverter handles TGA/BMP/JPG/PNG via stb_image, but
/// it deliberately copies DDS as-is (Spring archives ship DXT-
/// compressed textures the engine renderer used to consume directly).
/// Browsers can't fetch a `.dds` URI from a glTF `images[].uri`, so
/// for DDS sources we shell out to ImageMagick which decodes the
/// DXT data and re-encodes as PNG. Both branches log on failure;
/// caller is expected to drop the file from the model's texture set.
bool ConvertTextureToPng(const std::string& srcPath,
                         const std::string& dstPath,
                         const fs::path& textureConverter) {
    std::vector<std::string> argv;
    if (IsDdsFile(srcPath)) {
        argv = { "magick", srcPath, dstPath };
    } else {
        argv = { textureConverter.string(), srcPath, dstPath };
    }
    std::string out;
    if (!RunCommand(argv, out)) {
        SLOG(SPRING_LOG_WARNING,
            "texture conversion failed: %s -> %s\n%s",
            srcPath.c_str(), dstPath.c_str(), out.c_str());
        return false;
    }
    return true;
}

/// Pull `images[].uri` strings out of a .glb file's JSON chunk
/// without depending on a JSON parser. The glTF binary container is
/// a 12-byte header followed by length-prefixed chunks; the first
/// chunk is always JSON. We only need the image URIs so a small
/// scan over the JSON text is sufficient — and it avoids dragging
/// nlohmann/json into this otherwise dependency-light tool.
std::vector<std::string> ExtractGlbImageUris(const fs::path& glbPath) {
    std::ifstream f(glbPath, std::ios::binary);
    if (!f) return {};

    char header[12];
    if (!f.read(header, 12)) return {};
    if (std::memcmp(header, "glTF", 4) != 0) return {};

    char chunkHdr[8];
    if (!f.read(chunkHdr, 8)) return {};
    uint32_t chunkLen = 0;
    std::memcpy(&chunkLen, chunkHdr, 4);
    if (std::memcmp(chunkHdr + 4, "JSON", 4) != 0) return {};

    std::string json(chunkLen, '\0');
    if (!f.read(json.data(), chunkLen)) return {};

    auto imgKey = json.find("\"images\"");
    if (imgKey == std::string::npos) return {};
    auto arrStart = json.find('[', imgKey);
    if (arrStart == std::string::npos) return {};
    auto arrEnd = json.find(']', arrStart);
    if (arrEnd == std::string::npos) return {};

    std::vector<std::string> uris;
    size_t p = arrStart;
    while (p < arrEnd) {
        auto k = json.find("\"uri\"", p);
        if (k == std::string::npos || k >= arrEnd) break;
        auto colon = json.find(':', k);
        if (colon == std::string::npos || colon >= arrEnd) break;
        auto q1 = json.find('"', colon + 1);
        if (q1 == std::string::npos || q1 >= arrEnd) break;
        auto q2 = json.find('"', q1 + 1);
        if (q2 == std::string::npos || q2 >= arrEnd) break;
        uris.emplace_back(json, q1 + 1, q2 - q1 - 1);
        p = q2 + 1;
    }
    return uris;
}

/// Make sure every texture URI referenced by a freshly-written glb
/// has a sibling .png in `outRoot`. modelimporter is invoked with
/// `--texture-ext png` so the URIs already point at .png files;
/// this step locates the actual source bitmap (DDS/TGA/...) in the
/// game's unittextures/ directory and converts it. Cheap on re-runs
/// because the per-URI early exit on existing files is a single
/// stat() call.
void EnsureGlbTexturesAvailable(const fs::path& glbPath,
                                const fs::path& unittexturesDir,
                                const fs::path& outRoot,
                                const fs::path& textureConverter) {
    if (unittexturesDir.empty()) return;
    const auto uris = ExtractGlbImageUris(glbPath);
    for (const std::string& uri : uris) {
        // Skip data URIs (textures already embedded as base64 by
        // some formats) and any URI that isn't a bare filename.
        if (uri.empty() || uri.find(':') != std::string::npos) continue;
        if (uri.find('/') != std::string::npos ||
            uri.find('\\') != std::string::npos) continue;

        const fs::path target = outRoot / uri;
        if (fs::exists(target)) continue;

        const std::string stem = fs::path(uri).stem().string();
        const std::string srcTex = ResolveTextureByStem(unittexturesDir, stem);
        if (srcTex.empty()) {
            SLOG(SPRING_LOG_WARNING,
                "texture '%s' (referenced by %s) not found in %s",
                uri.c_str(), glbPath.filename().string().c_str(),
                unittexturesDir.string().c_str());
            continue;
        }
        ConvertTextureToPng(srcTex, target.string(), textureConverter);
    }
}

/// File extensions we hand to modelimporter. Matches the broad
/// set Assimp supports — the tool itself enforces format validity.
bool IsModelFile(const fs::path& p) {
    static const std::vector<std::string> exts = {
        ".s3o", ".3do", ".obj", ".fbx", ".dae", ".blend", ".3ds",
        ".lwo", ".stl", ".ply", ".gltf", ".glb", ".x", ".md2",
        ".md3", ".md5mesh",
    };
    const std::string ext = ToLower(p.extension().string());
    for (const auto& e : exts)
        if (ext == e) return true;
    return false;
}

/// Walk every model file under `<gameDir>/objects3d/` and run
/// modelimporter on it, writing the output under `<gameDir>/models/`.
/// modelimporter is invoked with `--texture-ext png` so every glb
/// references textures by `.png` URI; we then walk those URIs and
/// convert each source bitmap (DDS/TGA/BMP/...) from unittextures/
/// to a sibling .png next to the glb.
int ConvertModels(const fs::path& gameDir, const std::string& gameId,
                  const fs::path& modelImporterBin, bool force) {
    const fs::path source = ResolveSubDir(gameDir, "objects3d");
    if (source.empty()) {
        SLOG(SPRING_LOG_INFO, "%s: no objects3d/ directory, skipping model conversion",
            gameDir.string().c_str());
        return 0;
    }

    const fs::path unittexturesDir = ResolveSubDir(gameDir, "unittextures");
    const fs::path outRoot = gameDir / "models";
    const fs::path textureConverter = TEXTURECONVERTER_BINARY_PATH;
    std::error_code ec;
    fs::create_directories(outRoot, ec);

    int converted = 0, skipped = 0, failed = 0;
    for (const auto& entry : fs::recursive_directory_iterator(source)) {
        if (!entry.is_regular_file()) continue;
        if (!IsModelFile(entry.path())) continue;

        const std::string stem = entry.path().stem().string();
        const fs::path outPath = outRoot / (stem + ".glb");

        // mtime check: skip if the output is newer than the source
        bool needsRebuild = true;
        if (!force && fs::exists(outPath)) {
            const auto srcTime = fs::last_write_time(entry.path(), ec);
            const auto dstTime = fs::last_write_time(outPath, ec);
            if (!ec && dstTime >= srcTime) {
                needsRebuild = false;
            }
        }

        if (needsRebuild) {
            // `--texture-ext png` rewrites every texture URI in the
            // resulting glb to `.png` regardless of the source format.
            // The matching .png files are produced by
            // EnsureGlbTexturesAvailable below.
            std::vector<std::string> argv = {
                modelImporterBin.string(),
                "--texture-ext", "png",
                entry.path().string(),
                outPath.string(),
            };
            std::string output;
            if (!RunCommand(argv, output)) {
                failed++;
                SLOG(SPRING_LOG_ERROR, "modelimporter failed on %s\n%s",
                    entry.path().string().c_str(), output.c_str());
                continue;
            }
            converted++;
        } else {
            skipped++;
        }

        // Convert every texture the glb references. Cheap on re-runs
        // (per-URI early skip when the .png already exists).
        EnsureGlbTexturesAvailable(outPath, unittexturesDir, outRoot,
                                   textureConverter);
    }

    SLOG(SPRING_LOG_NOTICE, "%s: models %d converted, %d up-to-date, %d failed",
        gameDir.string().c_str(), converted, skipped, failed);
    return failed;
}

// ---------------------------------------------------------------
// Step 4: AI migration
// ---------------------------------------------------------------

/// Emit a minimal ai.config.lua alongside `main.lua`. The file
/// name becomes the AI's display name so the lobby has something
/// to show in the "Add AI" dropdown; authors are expected to edit
/// it afterward if they want richer metadata.
bool WriteAIConfig(const fs::path& aiDir, const std::string& displayName,
                   const std::string& mainLua)
{
    const fs::path outPath = aiDir / "ai.config.lua";
    if (fs::exists(outPath)) {
        SLOG(SPRING_LOG_INFO, "%s: ai.config.lua already exists, leaving alone",
            aiDir.string().c_str());
        return true;
    }

    std::string body =
        "-- Auto-generated by gameconverter.\n"
        "--\n"
        "-- Minimal metadata for an AI migrated from the legacy\n"
        "-- Spring-archive layout. Edit the `name` / `description`\n"
        "-- fields to taste — the lobby reads this file via\n"
        "-- ConfigReader::Load and shows `name` in the host's\n"
        "-- \"Add AI\" dropdown.\n"
        "\n"
        "return {\n"
        "    name  = \"" + displayName + "\",\n"
        "    entry = \"" + mainLua + "\",\n"
        "}\n";

    if (!WriteFileText(outPath, body))
        return false;
    SLOG(SPRING_LOG_NOTICE, "wrote %s", outPath.string().c_str());
    return true;
}

/// Migrate the `<game>/ai/` directory into the new layout.
/// Handles two source shapes:
///
///   - A flat `ai/<name>.lua` file becomes `ai/<name>/main.lua`
///     with a sibling `ai.config.lua`. The original file is
///     moved, not copied, so re-runs are idempotent.
///
///   - An existing `ai/<name>/` folder with a main.lua (or
///     similar) just gets an `ai.config.lua` if it doesn't
///     already have one.
void MigrateAIs(const fs::path& gameDir) {
    const fs::path aiRoot = gameDir / "ai";
    if (!fs::exists(aiRoot) || !fs::is_directory(aiRoot)) {
        SLOG(SPRING_LOG_INFO, "%s: no ai/ directory, skipping AI migration",
            gameDir.string().c_str());
        return;
    }

    int flatMoved = 0, folderStubbed = 0;
    for (const auto& entry : fs::directory_iterator(aiRoot)) {
        const fs::path& p = entry.path();

        if (entry.is_regular_file() && ToLower(p.extension().string()) == ".lua") {
            // Flat ai/<name>.lua → ai/<name>/main.lua
            const std::string stem = p.stem().string();
            const fs::path subDir = aiRoot / stem;
            std::error_code ec;
            fs::create_directories(subDir, ec);
            const fs::path newMain = subDir / "main.lua";

            if (!fs::exists(newMain)) {
                fs::rename(p, newMain, ec);
                if (ec) {
                    SLOG(SPRING_LOG_ERROR, "failed to move %s -> %s: %s",
                        p.string().c_str(), newMain.string().c_str(),
                        ec.message().c_str());
                    continue;
                }
                flatMoved++;
            }
            WriteAIConfig(subDir, stem, "main.lua");
            continue;
        }

        if (entry.is_directory()) {
            // Existing ai/<name>/ folder. Add an ai.config.lua if
            // it doesn't already have one; leave the rest alone.
            const std::string displayName = p.filename().string();

            // Guess the entry file name — prefer main.lua, else
            // the first .lua file in the directory.
            std::string entryName = "main.lua";
            if (!fs::exists(p / "main.lua")) {
                for (const auto& child : fs::directory_iterator(p)) {
                    if (child.is_regular_file() &&
                        ToLower(child.path().extension().string()) == ".lua") {
                        entryName = child.path().filename().string();
                        break;
                    }
                }
            }
            if (WriteAIConfig(p, displayName, entryName))
                folderStubbed++;
        }
    }

    SLOG(SPRING_LOG_NOTICE, "%s: AI migration — %d flat .lua moved, %d folder(s) stubbed",
        gameDir.string().c_str(), flatMoved, folderStubbed);
}

// ---------------------------------------------------------------
// Source tree copy
// ---------------------------------------------------------------

/// Recursively copy `src` into `dst`, skipping files that already exist
/// and are newer than the source (so converted outputs aren't clobbered).
void CopySourceTree(const fs::path& src, const fs::path& dst) {
    std::error_code ec;
    fs::create_directories(dst, ec);

    for (const auto& entry : fs::recursive_directory_iterator(src)) {
        const auto rel = fs::relative(entry.path(), src, ec);
        const auto target = dst / rel;

        if (entry.is_directory()) {
            fs::create_directories(target, ec);
            continue;
        }
        if (!entry.is_regular_file()) continue;

        if (fs::exists(target)) {
            auto srcTime = fs::last_write_time(entry.path(), ec);
            auto dstTime = fs::last_write_time(target, ec);
            if (!ec && dstTime >= srcTime) continue;
        }

        fs::copy_file(entry.path(), target,
                       fs::copy_options::overwrite_existing, ec);
        if (ec) {
            SLOG(SPRING_LOG_WARNING, "copy failed: %s -> %s: %s",
                entry.path().string().c_str(), target.string().c_str(),
                ec.message().c_str());
        }
    }
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "prepare a legacy Spring-archive game for spring-web.\n"
        "\n"
        "usage: %s [options] <game-dir>\n"
        "\n"
        "  <game-dir>   path to a game archive root, e.g. content/games/papertanks.\n"
        "\n"
        "options:\n"
        "  --data-dir D        Output data directory (default: data).\n"
        "  --force             Overwrite existing game.config.lua / model\n"
        "                      outputs even if they look up to date.\n"
        "  --modelimporter P   Path to the modelimporter binary. Defaults to\n"
        "                      ./build/debug/tools/modelimporter/modelimporter,\n"
        "                      falling back to ./build/release/... if present.\n"
        "  --skip-models       Do not run modelimporter. Useful when the\n"
        "                      lobby has already cached the glb outputs or\n"
        "                      you just want to refresh the game.config.lua\n"
        "                      wrapper and the AI layout.\n"
        "  --skip-ai           Do not touch ai/ — leave the legacy layout\n"
        "                      in place.\n"
        "  --log-server <url>  Send logs to a springlog server.\n"
        "  --log-level <level> Set minimum log level (debug/info/\n"
        "                      notice/warning/error).\n"
        "\n"
        "The source tree is copied to data/games/<id>/ before processing.\n"
        "Each step is idempotent: re-running the tool on a converted game\n"
        "is a no-op unless --force is passed or a source file changed.",
        argv0);
}

} // namespace

int main(int argc, char* argv[]) {
    springlog_init("gameconverter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string gameDirArg;
    std::string modelImporterArg;
    std::string dataDir = "data";
    std::string logServerUrl;
    bool force = false;
    bool skipModels = false;
    bool skipAI = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--force") force = true;
        else if (arg == "--skip-models") skipModels = true;
        else if (arg == "--skip-ai") skipAI = true;
        else if (arg == "--data-dir" && i + 1 < argc) dataDir = argv[++i];
        else if (arg == "--modelimporter" && i + 1 < argc) modelImporterArg = argv[++i];
        else if (arg == "--log-server" && i + 1 < argc) logServerUrl = argv[++i];
        else if (arg == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        }
        else if (arg == "-h" || arg == "--help") { PrintUsage(argv[0]); springlog_shutdown(); return 0; }
        else if (!arg.empty() && arg[0] == '-') {
            SLOG(SPRING_LOG_ERROR, "unknown option: %s", arg.c_str());
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 2;
        }
        else gameDirArg = arg;
    }

    if (!logServerUrl.empty()) {
        springlog_net_init(logServerUrl.c_str(), "");
    }

    if (gameDirArg.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 2;
    }

    const fs::path sourceDir = fs::absolute(gameDirArg);
    if (!fs::exists(sourceDir) || !fs::is_directory(sourceDir)) {
        SLOG(SPRING_LOG_ERROR, "not a directory: %s",
            sourceDir.string().c_str());
        springlog_shutdown();
        return 1;
    }

    const std::string gameId = ToLower(sourceDir.filename().string());

    // Copy source tree to data/games/<id>/ so the lobby only reads
    // from data/. All subsequent operations work on the copy.
    const fs::path gameDir = fs::path(dataDir) / "games" / gameId;
    SLOG(SPRING_LOG_NOTICE, "processing game '%s': %s -> %s",
        gameId.c_str(), sourceDir.string().c_str(),
        gameDir.string().c_str());
    CopySourceTree(sourceDir, gameDir);

    // Resolve the modelimporter path.
    fs::path modelImporterBin;
    if (!modelImporterArg.empty()) {
        modelImporterBin = modelImporterArg;
    } else if (fs::exists("build/release/tools/modelimporter/modelimporter")) {
        modelImporterBin = "build/release/tools/modelimporter/modelimporter";
    } else {
        modelImporterBin = "build/debug/tools/modelimporter/modelimporter";
    }
    if (!skipModels && !fs::exists(modelImporterBin)) {
        SLOG(SPRING_LOG_ERROR,
            "modelimporter not found at %s — build it first, "
            "or pass --modelimporter <path> / --skip-models",
            modelImporterBin.string().c_str());
        springlog_shutdown();
        return 1;
    }

    int failed = 0;
    ConvertGameConfig(gameDir, force);
    ConvertLobbyConfig(gameDir, force);

    if (!skipModels) {
        failed += ConvertModels(gameDir, gameId, modelImporterBin, force);
    }

    if (!skipAI) {
        MigrateAIs(gameDir);
    }

    SLOG(SPRING_LOG_NOTICE, "done (%d failures)", failed);
    springlog_shutdown();
    return failed == 0 ? 0 : 1;
}
