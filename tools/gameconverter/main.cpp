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

#ifndef AUDIOCONVERTER_BINARY_PATH
#define AUDIOCONVERTER_BINARY_PATH "audioconverter"
#endif

#define LOG_SECTION "game-convert"

#include <cctype>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <system_error>
#include <utility>
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

// Forward declarations for helpers that live further down (model
// conversion section). The projectile-texture pass uses them but
// keeping their definitions next to the model pipeline keeps that
// chunk self-contained.
bool ConvertTextureToKtx2(const std::string& srcPath,
                          const std::string& dstPath,
                          const fs::path& textureConverter);
void WriteDirManifest(const fs::path& dir, bool recursive = false);

// ---------------------------------------------------------------
// Step 3: bitmap → KTX2 conversion (in-place)
// ---------------------------------------------------------------
//
// Spring weapon defs reference textures by bare logical name
// (`largelaser`, `flarescale01`). The runtime resolves the name
// through `gamedata/resources.lua`'s `graphics.projectiletextures`
// table to a relative path under `bitmaps/` — `largelaser` →
// `gpl/largelaserfalloff.png` for ZK, for example.
//
// Earlier iterations of this pass tried to flatten the bitmap tree
// into a single `projectiletextures/` directory keyed by source-file
// stem. That conflated unrelated files that happened to share a stem
// (`scars/scar2.tga` vs `Unknown/scars_new/scar2.png`) and silently
// broke any logical name that didn't match its source filename
// (`largelaser` got written as `largelaserfalloff.ktx2` and 404'd at
// fetch time).
//
// The new design is simpler and architecturally correct:
//
//   1. Walk `bitmaps/` recursively. For every supported format
//      (.tga / .png / .bmp / .jpg / .jpeg / .webp / .dds), write a
//      KTX2 sibling next to the source preserving the original
//      directory structure.
//   2. Generate a recursive `bitmaps/manifest.json` listing every
//      file in the tree.
//   3. The lobby ships `gamedata/resources.lua` parsed as JSON via
//      `/api/games/<id>/resources.json`; the client looks the
//      logical name up there, gets the source path, swaps the
//      extension to `.ktx2`, and probes the manifest. All resolution
//      lives client-side.
//
// Two roots are processed:
//   - Engine: `cont/base/bitmaps/bitmaps/` → `data/engine/bitmaps/`
//     (mirrored once, then converted in place)
//   - Game:   `<gameDir>/bitmaps/` (already mirrored by CopySourceTree
//             into the data-side path, converted in place there)

/// Bitmap source extensions textureconverter accepts, ordered by
/// preference. When two files share a logical stem (e.g. engine ships
/// both `flare.bmp` and `flare.tga`) the lowest-index extension wins.
/// `.tga` ranks above `.bmp` because TGA preserves alpha; `.dds` ranks
/// first because BC-encoded DDS sources are passed through to KTX2
/// without re-encoding (cheaper, and lossless w.r.t. the prior pass).
/// Returns the priority index (lower = higher priority), or -1 if the
/// extension is not a bitmap.
int BitmapExtPriority(const fs::path& p) {
    static const char* const kExts[] = {
        ".dds", ".tga", ".png", ".bmp", ".jpg", ".jpeg", ".webp",
    };
    const std::string ext = ToLower(p.extension().string());
    for (size_t i = 0; i < sizeof(kExts)/sizeof(kExts[0]); ++i)
        if (ext == kExts[i]) return (int)i;
    return -1;
}

bool IsBitmapFile(const fs::path& p) {
    return BitmapExtPriority(p) >= 0;
}

/// Mirror the source bitmap tree at `srcRoot` into `dstRoot`, then
/// for every bitmap file write a `.ktx2` sibling preserving the
/// directory structure. Re-runs are idempotent: source files are
/// copied only when missing or newer, and KTX2 outputs are skipped
/// when newer than the source. Returns the number of conversion
/// failures.
///
/// "In-place" here means "next to the source file in the destination
/// tree" — we never write into the read-only source location. The
/// caller picks dstRoot (`data/engine/bitmaps/` for engine,
/// `data/games/<id>/bitmaps/` for game; the latter is already where
/// CopySourceTree put the source).
int ConvertBitmapsInPlace(const fs::path& srcRoot,
                          const fs::path& dstRoot,
                          const fs::path& textureConverter,
                          bool force,
                          bool mirrorSources,
                          int& copied, int& converted, int& uptodate, int& failed) {
    std::error_code ec;
    if (!fs::exists(srcRoot, ec) || !fs::is_directory(srcRoot, ec)) return 0;
    fs::create_directories(dstRoot, ec);

    // First pass: walk all bitmaps. Mirror them all if needed (we
    // preserve every source on disk for direct VFS access), but for
    // KTX2 conversion group by `<dir>/<stem>` and pick the highest-
    // priority extension so when both `flare.bmp` and `flare.tga`
    // exist in the same directory, the alpha-bearing TGA wins as the
    // single `flare.ktx2`. Without this, the alphabetical walk had
    // `.bmp` win when `.tga` was also present, silently dropping the
    // alpha channel that resources.lua-driven lookups depend on.
    struct Candidate {
        fs::path path;       // source file, post-mirror if applicable
        int priority;        // BitmapExtPriority (lower = preferred)
    };
    std::unordered_map<std::string, Candidate> winners;

    for (const auto& entry : fs::recursive_directory_iterator(srcRoot, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        if (!IsBitmapFile(entry.path())) continue;

        const fs::path rel = fs::relative(entry.path(), srcRoot, ec);
        if (ec) { ec.clear(); continue; }
        const fs::path mirroredSrc = mirrorSources
            ? (dstRoot / rel)
            : entry.path();

        // Mirror every source unconditionally (when needed). The
        // original case is preserved so direct lookups still work;
        // the dedup below only affects which one becomes `.ktx2`.
        if (mirrorSources) {
            fs::create_directories(mirroredSrc.parent_path(), ec);
            bool needCopy = !fs::exists(mirroredSrc, ec);
            if (!needCopy) {
                const auto srcT = fs::last_write_time(entry.path(), ec);
                const auto dstT = fs::last_write_time(mirroredSrc, ec);
                if (!ec && dstT < srcT) needCopy = true;
                else ec.clear();
            }
            if (needCopy) {
                fs::copy_file(entry.path(), mirroredSrc,
                    fs::copy_options::overwrite_existing, ec);
                if (ec) { failed++; ec.clear(); continue; }
                copied++;
            }
        }

        // Group key: `<parent_dir>/<stem>` (case-folded). Two files
        // in different directories never collide, so adjacent .bmp
        // and .tga files in different folders get separate .ktx2.
        std::string key = mirroredSrc.parent_path().string();
        std::string stemLower = mirroredSrc.stem().string();
        for (auto& c : stemLower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        key += '/';
        key += stemLower;

        const int prio = BitmapExtPriority(entry.path());
        auto it = winners.find(key);
        if (it == winners.end()) {
            winners.emplace(key, Candidate{mirroredSrc, prio});
        } else if (prio < it->second.priority) {
            it->second = Candidate{mirroredSrc, prio};
        }
    }

    // Second pass: emit one KTX2 per (dir, stem) winner.
    for (const auto& kv : winners) {
        const fs::path& src = kv.second.path;
        fs::path dstPath = src;
        dstPath.replace_extension(".ktx2");

        if (!force && fs::exists(dstPath, ec)) {
            const auto srcTime = fs::last_write_time(src, ec);
            const auto dstTime = fs::last_write_time(dstPath, ec);
            if (!ec && dstTime >= srcTime) {
                uptodate++;
                continue;
            }
            ec.clear();
        }

        if (ConvertTextureToKtx2(src.string(), dstPath.string(),
                                 textureConverter)) {
            converted++;
        } else {
            failed++;
        }
    }
    return failed;
}

/// Convert engine and game bitmap trees in place. Both roots emit a
/// recursive `manifest.json` next to the converted files so the
/// client can probe `<resources.lua-path>.ktx2` lookups without
/// flooding 404s.
int ConvertProjectileTextures(const fs::path& gameDir,
                              const fs::path& dataDir,
                              bool force) {
    const fs::path textureConverter = TEXTURECONVERTER_BINARY_PATH;
    int totalFailed = 0;
    int eP = 0, eC = 0, eU = 0, eF = 0, gP = 0, gC = 0, gU = 0, gF = 0;

    // Engine: source lives at cont/base/bitmaps/bitmaps/ (read-only
    // from the gameconverter's perspective). Mirror into
    // data/engine/bitmaps/, convert in place there.
    const fs::path engineSrc = "cont/base/bitmaps/bitmaps";
    const fs::path engineOut = dataDir / "engine" / "bitmaps";
    totalFailed += ConvertBitmapsInPlace(engineSrc, engineOut,
                                         textureConverter, force,
                                         /*mirrorSources*/ true,
                                         eP, eC, eU, eF);
    if (eP + eC + eU + eF > 0) {
        WriteDirManifest(engineOut, /*recursive*/ true);
        SLOG(SPRING_LOG_NOTICE,
            "engine bitmaps: %d copied, %d converted, %d up-to-date, %d failed",
            eP, eC, eU, eF);
    }

    // Game: gameDir is the data-side copy already populated by
    // CopySourceTree, so the source `bitmaps/` is at gameDir/bitmaps
    // and conversion happens in place there.
    const fs::path gameBitmaps = ResolveSubDir(gameDir, "bitmaps");
    if (!gameBitmaps.empty()) {
        totalFailed += ConvertBitmapsInPlace(gameBitmaps, gameBitmaps,
                                             textureConverter, force,
                                             /*mirrorSources*/ false,
                                             gP, gC, gU, gF);
        if (gP + gC + gU + gF > 0) {
            WriteDirManifest(gameBitmaps, /*recursive*/ true);
            SLOG(SPRING_LOG_NOTICE,
                "%s bitmaps: %d converted, %d up-to-date, %d failed",
                gameDir.filename().string().c_str(), gC, gU, gF);
        }
    } else {
        SLOG(SPRING_LOG_INFO,
            "%s: no bitmaps/ directory, skipping game bitmap pass",
            gameDir.string().c_str());
    }
    return totalFailed;
}

// ---------------------------------------------------------------
// Step 3b: audio conversion
// ---------------------------------------------------------------
//
// Walk every .wav/.ogg/.mp3/.flac/.m4a/.aac file under the game's
// data-side tree and re-encode it to a sibling `.webm` (Opus). The
// extension match is case-insensitive — legacy Spring archives
// commonly mix `.wav` and `.WAV`. After successful conversion, the
// source file is deleted from the data tree so the runtime never
// sees a non-`.webm` audio asset.
//
// `gamedata/sounds.lua` and other Lua files are untouched. Entries
// that hand-author `.wav` paths are rewritten to `.webm` at runtime
// by the server's `NormalizeSoundPath` and the client's
// `normalizeSoundPath`. Entries that probe `VFS.DirList` for files
// see only `.webm` because that's all that's left on disk.

static bool IsAudioSource(const fs::path& p) {
    static const char* const kExts[] = {
        ".wav", ".ogg", ".mp3", ".flac", ".m4a", ".aac",
    };
    const std::string ext = ToLower(p.extension().string());
    for (const char* e : kExts) {
        if (ext == e) return true;
    }
    return false;
}

/// Map a source audio path to one of audioconverter's three encoder
/// categories. The category drives only the Opus bitrate hint
/// (sfx=64k, ui=48k, music=96k stereo); it does NOT correspond to
/// Recoil's runtime channels (which are caller-determined when a
/// SoundEvent is emitted or a widget calls Spring.PlaySoundFile).
static std::string DeriveAudioCategory(const fs::path& relPath) {
    const std::string lower = ToLower(relPath.string());
    // Both forward and back slashes appear depending on host OS;
    // normalise the lookup string to forward slashes so substring
    // matching is portable.
    std::string norm = lower;
    for (auto& c : norm) if (c == '\\') c = '/';

    if (norm.find("luaui/sounds/") != std::string::npos ||
        norm.find("/ui/")          != std::string::npos) {
        return "ui";
    }
    if (norm.find("sounds/music/") != std::string::npos ||
        norm.find("/music/")       != std::string::npos) {
        return "music";
    }
    return "sfx";
}

static bool ConvertAudioFile(const fs::path& srcPath,
                             const fs::path& dstPath,
                             const std::string& category,
                             const fs::path& audioConverter,
                             bool force) {
    std::vector<std::string> argv = {
        audioConverter.string(),
        "--category", category,
    };
    if (force) argv.push_back("--force");
    argv.push_back(srcPath.string());
    argv.push_back(dstPath.string());

    std::string out;
    if (!RunCommand(argv, out)) {
        SLOG(SPRING_LOG_WARNING,
            "audio conversion failed: %s -> %s\n%s",
            srcPath.string().c_str(), dstPath.string().c_str(),
            out.c_str());
        return false;
    }
    return true;
}

/// Walk `gameDir/sounds/**` and `gameDir/LuaUI/Sounds/**` (any case),
/// re-encoding every audio source to a sibling `.webm` and removing
/// the original. Returns the number of failures. Audio is
/// non-critical to gameplay, so failures are warnings rather than
/// hard errors.
int ConvertAudio(const fs::path& gameDir, bool force) {
    const fs::path audioConverter = AUDIOCONVERTER_BINARY_PATH;
    int converted = 0, uptodate = 0, failed = 0, removed = 0;

    if (!fs::exists(audioConverter)) {
        SLOG(SPRING_LOG_WARNING,
            "audioconverter not found at %s — skipping audio conversion. "
            "Install ffmpeg and rebuild to enable the audio pipeline.",
            audioConverter.string().c_str());
        return 0;
    }

    std::error_code ec;
    for (const auto& entry : fs::recursive_directory_iterator(gameDir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        if (!IsAudioSource(entry.path())) continue;

        const fs::path srcPath = entry.path();
        fs::path dstPath = srcPath;
        dstPath.replace_extension(".webm");

        // Skip-by-mtime: don't re-encode if dst is already newer.
        bool needConvert = true;
        if (!force && fs::exists(dstPath, ec)) {
            const auto srcT = fs::last_write_time(srcPath, ec);
            const auto dstT = fs::last_write_time(dstPath, ec);
            if (!ec && dstT >= srcT) {
                needConvert = false;
                uptodate++;
            }
            ec.clear();
        }

        if (needConvert) {
            const fs::path rel = fs::relative(srcPath, gameDir, ec);
            const std::string category = DeriveAudioCategory(
                ec ? srcPath : rel);
            ec.clear();

            if (ConvertAudioFile(srcPath, dstPath, category,
                                  audioConverter, force)) {
                converted++;
            } else {
                failed++;
                // Don't delete the source if conversion failed —
                // leave it for the next run to retry.
                continue;
            }
        }

        // Source pruning: delete the original .wav/.ogg/.mp3/etc.
        // so the runtime only ever sees `.webm` files. Done even
        // when up-to-date (the dst could have been hand-encoded).
        if (fs::exists(srcPath, ec)) {
            fs::remove(srcPath, ec);
            if (!ec) removed++;
            ec.clear();
        }
    }

    if (converted + uptodate + failed + removed > 0) {
        SLOG(SPRING_LOG_NOTICE,
            "%s audio: %d converted, %d up-to-date, %d sources pruned, %d failed",
            gameDir.filename().string().c_str(),
            converted, uptodate, removed, failed);
    } else {
        SLOG(SPRING_LOG_INFO, "%s: no audio sources found",
            gameDir.string().c_str());
    }
    return failed;
}

// ---------------------------------------------------------------
// Step 3b: TDF → Lua conversion
// ---------------------------------------------------------------
//
// Legacy Total-Annihilation-style `[NAME] { key=value; }` weapon
// defs (zk/weapons/*.tdf) used to be parsed at engine start via
// springcontent's parse_tdf.lua + weapondefs.lua loader. We don't
// ship that springcontent layer, so the .tdf files were silently
// ignored. This pass converts each .tdf to a sibling .lua that
// returns a single-key table — the same shape parse_tdf.lua would
// have produced in memory — so a thin engine-side weapondefs loader
// can `VFS.Include` the .lua files directly. Source .tdf files are
// left in place for round-trip auditing.

namespace tdf {

struct Section {
    std::string name;  // lowercased
    // Insertion-ordered key/value pairs. Keys are lowercased; values
    // are kept as raw strings (the engine-side weapondef loader
    // coerces to int/float/bool as needed).
    std::vector<std::pair<std::string, std::string>> values;
    std::vector<Section> subs;
};

/// Strip leading/trailing ASCII whitespace.
static std::string Trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && std::isspace(static_cast<unsigned char>(s[a]))) ++a;
    while (b > a && std::isspace(static_cast<unsigned char>(s[b - 1]))) --b;
    return s.substr(a, b - a);
}

/// Skip whitespace and `// ...` / `/* ... */` comments at `pos`.
static void SkipWhitespaceAndComments(const std::string& src, size_t& pos) {
    while (pos < src.size()) {
        char c = src[pos];
        if (std::isspace(static_cast<unsigned char>(c))) { ++pos; continue; }
        if (c == '/' && pos + 1 < src.size()) {
            if (src[pos + 1] == '/') {
                pos += 2;
                while (pos < src.size() && src[pos] != '\n') ++pos;
                continue;
            }
            if (src[pos + 1] == '*') {
                pos += 2;
                while (pos + 1 < src.size() &&
                       !(src[pos] == '*' && src[pos + 1] == '/')) ++pos;
                if (pos + 1 < src.size()) pos += 2;
                continue;
            }
        }
        break;
    }
}

/// Parse a single section assuming `[` has not yet been consumed.
/// On error, sets `err` and returns false.
static bool ParseSection(const std::string& src, size_t& pos,
                         Section& out, std::string& err) {
    SkipWhitespaceAndComments(src, pos);
    if (pos >= src.size() || src[pos] != '[') {
        err = "expected '['";
        return false;
    }
    ++pos; // consume [
    size_t nameStart = pos;
    while (pos < src.size() && src[pos] != ']') ++pos;
    if (pos >= src.size()) { err = "unterminated section header"; return false; }
    std::string name = Trim(src.substr(nameStart, pos - nameStart));
    ++pos; // consume ]
    out.name = ToLower(name);

    SkipWhitespaceAndComments(src, pos);
    if (pos >= src.size() || src[pos] != '{') {
        err = "expected '{' after section '" + out.name + "'";
        return false;
    }
    ++pos; // consume {

    while (true) {
        SkipWhitespaceAndComments(src, pos);
        if (pos >= src.size()) {
            err = "unterminated section '" + out.name + "'";
            return false;
        }
        if (src[pos] == '}') { ++pos; return true; }
        if (src[pos] == '[') {
            Section sub;
            if (!ParseSection(src, pos, sub, err)) return false;
            out.subs.push_back(std::move(sub));
            continue;
        }
        // key=value; — key is anything up to '='. value is anything up to ';'.
        size_t keyStart = pos;
        while (pos < src.size() && src[pos] != '=' &&
               src[pos] != ';' && src[pos] != '}' && src[pos] != '\n') ++pos;
        if (pos >= src.size() || src[pos] != '=') {
            err = "expected '=' in section '" + out.name + "'";
            return false;
        }
        std::string key = ToLower(Trim(src.substr(keyStart, pos - keyStart)));
        ++pos; // consume =
        size_t valStart = pos;
        while (pos < src.size() && src[pos] != ';' && src[pos] != '\n') ++pos;
        std::string value = Trim(src.substr(valStart, pos - valStart));
        if (pos < src.size() && src[pos] == ';') ++pos;
        if (!key.empty()) {
            out.values.emplace_back(std::move(key), std::move(value));
        }
    }
}

/// Heuristic: does `s` parse as a finite Lua-compatible number whose
/// canonical form round-trips? Used to decide whether to emit `42` or
/// `"42"` in the .lua output. Strings that look numeric-ish but
/// contain trailing garbage (e.g. `"480x"`) fall back to string.
static bool LooksLikeNumber(const std::string& s) {
    if (s.empty()) return false;
    char* end = nullptr;
    errno = 0;
    (void) std::strtod(s.c_str(), &end);
    if (errno != 0) return false;
    if (end != s.c_str() + s.size()) return false;
    return true;
}

/// Lua string escape for double-quoted literals. Covers the cases
/// that show up in real TDFs: backslashes, double quotes, control
/// characters.
static std::string EscapeLuaString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        switch (c) {
            case '\\': out += "\\\\"; break;
            case '"':  out += "\\\""; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\%d",
                                  static_cast<unsigned char>(c));
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

/// Is `key` a valid Lua identifier? Determines whether to emit `key =`
/// vs `["key"] =`.
static bool IsIdentifier(const std::string& s) {
    if (s.empty()) return false;
    char c0 = s[0];
    if (!(std::isalpha(static_cast<unsigned char>(c0)) || c0 == '_')) return false;
    for (char c : s) {
        if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '_')) return false;
    }
    return true;
}

/// Emit a Section's body (the part between `{` and `}` in Lua).
static void EmitBody(const Section& s, std::string& out, int indent) {
    const std::string pad(indent, ' ');
    for (const auto& [k, v] : s.values) {
        out += pad;
        if (IsIdentifier(k)) {
            out += k;
        } else {
            out += "[\"" + EscapeLuaString(k) + "\"]";
        }
        out += " = ";
        if (LooksLikeNumber(v)) {
            out += v;
        } else {
            out += "\"" + EscapeLuaString(v) + "\"";
        }
        out += ",\n";
    }
    for (const auto& sub : s.subs) {
        out += pad;
        if (IsIdentifier(sub.name)) {
            out += sub.name;
        } else {
            out += "[\"" + EscapeLuaString(sub.name) + "\"]";
        }
        out += " = {\n";
        EmitBody(sub, out, indent + 2);
        out += pad + "},\n";
    }
}

/// Render a parsed root section to a complete .lua file body.
static std::string EmitLua(const Section& root) {
    std::string out;
    out += "-- generated by gameconverter from the sibling .tdf file. do not edit.\n";
    out += "return {\n";
    out += "  " + (IsIdentifier(root.name)
                    ? root.name
                    : "[\"" + EscapeLuaString(root.name) + "\"]")
        + " = {\n";
    EmitBody(root, out, 4);
    out += "  },\n";
    out += "}\n";
    return out;
}

} // namespace tdf

/// Convert one .tdf file to a sibling .lua. Returns true on success
/// (including up-to-date skip). Source .tdf is left in place.
static bool ConvertTdfFile(const fs::path& srcPath, bool force,
                           bool& wasUpToDate) {
    fs::path dstPath = srcPath;
    dstPath.replace_extension(".lua");

    std::error_code ec;
    if (!force && fs::exists(dstPath, ec)) {
        const auto srcT = fs::last_write_time(srcPath, ec);
        const auto dstT = fs::last_write_time(dstPath, ec);
        if (!ec && dstT >= srcT) {
            wasUpToDate = true;
            return true;
        }
        ec.clear();
    }

    std::ifstream f(srcPath, std::ios::binary);
    if (!f) {
        SLOG(SPRING_LOG_WARNING, "tdf: cannot read %s",
             srcPath.string().c_str());
        return false;
    }
    std::stringstream buf;
    buf << f.rdbuf();
    const std::string src = buf.str();

    size_t pos = 0;
    tdf::Section root;
    std::string err;
    tdf::SkipWhitespaceAndComments(src, pos);
    if (pos >= src.size()) {
        SLOG(SPRING_LOG_WARNING, "tdf: empty file %s",
             srcPath.string().c_str());
        return false;
    }
    if (!tdf::ParseSection(src, pos, root, err)) {
        SLOG(SPRING_LOG_WARNING, "tdf: parse failed in %s: %s",
             srcPath.string().c_str(), err.c_str());
        return false;
    }

    const std::string body = tdf::EmitLua(root);
    if (!WriteFileText(dstPath, body)) {
        SLOG(SPRING_LOG_WARNING, "tdf: cannot write %s",
             dstPath.string().c_str());
        return false;
    }
    return true;
}

/// Walk `<gameDir>/weapons/**/*.tdf` and emit `*.lua` next to each.
/// Source .tdf files are preserved (caller-visible audit trail). Any
/// other location with TDFs (e.g. `features/`, `units/` in old TA
/// archives) is intentionally not scanned — those formats predate
/// what ZK ships and aren't worth supporting until a game needs them.
int ConvertTdfs(const fs::path& gameDir, bool force) {
    const fs::path weaponsDir = gameDir / "weapons";
    std::error_code ec;
    if (!fs::is_directory(weaponsDir, ec)) return 0;

    int converted = 0, uptodate = 0, failed = 0;
    for (const auto& entry : fs::recursive_directory_iterator(weaponsDir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        const std::string ext = ToLower(entry.path().extension().string());
        if (ext != ".tdf") continue;

        bool wasUpToDate = false;
        if (ConvertTdfFile(entry.path(), force, wasUpToDate)) {
            if (wasUpToDate) uptodate++; else converted++;
        } else {
            failed++;
        }
    }

    if (converted + uptodate + failed > 0) {
        SLOG(SPRING_LOG_NOTICE,
             "%s tdf: %d converted, %d up-to-date, %d failed",
             gameDir.filename().string().c_str(),
             converted, uptodate, failed);
    }
    return failed;
}

// ---------------------------------------------------------------
// Step 4: model + texture conversion
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

/// Locate a texture by its stem, scanning every source extension a
/// Spring archive might use. Order matters: DDS is by far the most
/// common in modern games, TGA is the historical 3DO/S3O fallback,
/// and the rest cover hand-authored variants. textureconverter
/// accepts every one of these and produces a single canonical
/// `.ktx2` output.
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

/// Convert a single texture to a `.ktx2` sibling. textureconverter
/// auto-detects the source format (DDS-as-blocks for BC1/BC3/BC4/BC5,
/// stb_image -> UASTC for everything else) and writes a single
/// canonical KTX2 output regardless of input format.
bool ConvertTextureToKtx2(const std::string& srcPath,
                          const std::string& dstPath,
                          const fs::path& textureConverter) {
    std::vector<std::string> argv = {
        textureConverter.string(),
        "--encoding", "uastc",
        srcPath, dstPath,
    };
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

/// Extract `tex1` / `tex2` filenames from a model's config sidecar.
/// Three sources are consulted in priority order:
///
///   1. `<glbStem>.config.lua`   — hand-authored override at the
///                                  output level (rare, but wins).
///   2. `<sourceModel>.lua`      — Spring's author-config convention
///                                  alongside the source model file
///                                  (e.g. `strikecom_1.dae.lua`).
///                                  Standard for Collada/legacy assets
///                                  where the on-disk format has no
///                                  native tex1/tex2 channel.
///   3. `<glbStem>.config.json`  — what modelimporter writes; only
///                                  carries tex1/tex2 when Assimp's
///                                  importer for the source format
///                                  populated them (true for S3O, not
///                                  for `.dae`).
///
/// `sourceModelPath` may be empty if no source path is known — in
/// that case we just skip step 2.
void ExtractConfigTextureRefs(const fs::path& glbPath,
                              const fs::path& sourceModelPath,
                              std::string& outTex1, std::string& outTex2) {
    outTex1.clear();
    outTex2.clear();
    const fs::path stem = glbPath.parent_path() / glbPath.stem();
    const fs::path luaPath  = stem.string() + ".config.lua";
    const fs::path jsonPath = stem.string() + ".config.json";

    auto readField = [](const std::string& contents,
                        const std::string& key,
                        bool isLua) -> std::string {
        // Lua source: `tex1 = "name.ktx2"`
        // JSON:       `"tex1": "name.ktx2"`
        // Both forms reduce to "find the key, then read the next
        // double-quoted string after it".
        const std::string needle = isLua ? key : ("\"" + key + "\"");
        size_t k = contents.find(needle);
        if (k == std::string::npos) return {};
        size_t after = k + needle.size();
        // Skip past the separator (`:` for JSON, `=` for Lua) and any
        // whitespace, landing on the value's opening quote.
        size_t q1 = contents.find('"', after);
        if (q1 == std::string::npos) return {};
        size_t q2 = contents.find('"', q1 + 1);
        if (q2 == std::string::npos) return {};
        return contents.substr(q1 + 1, q2 - q1 - 1);
    };

    auto loadText = [](const fs::path& p) -> std::string {
        std::ifstream in(p, std::ios::binary);
        if (!in) return {};
        return std::string{std::istreambuf_iterator<char>(in),
                           std::istreambuf_iterator<char>()};
    };

    auto rewriteToKtx2 = [](std::string& name) {
        if (name.empty()) return;
        const auto dot = name.find_last_of('.');
        const auto slash = name.find_last_of("/\\");
        if (dot == std::string::npos ||
            (slash != std::string::npos && dot < slash)) {
            name += ".ktx2";
        } else {
            name = name.substr(0, dot) + ".ktx2";
        }
    };

    // Step 1: hand-authored output-level .config.lua override.
    if (fs::exists(luaPath)) {
        const std::string txt = loadText(luaPath);
        outTex1 = readField(txt, "tex1", true);
        outTex2 = readField(txt, "tex2", true);
    }

    // Step 2: Spring author-config alongside the source model
    // (`<modelname>.<ext>.lua`, e.g. `strikecom_1.dae.lua`). Only
    // checked if the higher-priority sources didn't already populate
    // both fields. The on-disk filenames in these files are typically
    // `.dds`/`.tga` — rewrite to `.ktx2` to match the runtime convention.
    if ((outTex1.empty() || outTex2.empty()) && !sourceModelPath.empty()) {
        const fs::path springLua = sourceModelPath.string() + ".lua";
        if (fs::exists(springLua)) {
            const std::string txt = loadText(springLua);
            std::string t1 = readField(txt, "tex1", true);
            std::string t2 = readField(txt, "tex2", true);
            rewriteToKtx2(t1);
            rewriteToKtx2(t2);
            if (outTex1.empty()) outTex1 = t1;
            if (outTex2.empty()) outTex2 = t2;
        }
    }

    // Step 3: machine-generated .config.json (only carries tex1/tex2
    // for source formats Assimp's importer fills in, e.g. S3O).
    if (fs::exists(jsonPath)) {
        const std::string txt = loadText(jsonPath);
        if (outTex1.empty()) outTex1 = readField(txt, "tex1", false);
        if (outTex2.empty()) outTex2 = readField(txt, "tex2", false);
    }
}

/// Convert a single referenced texture by filename (e.g.
/// `3do2s3o_atlas_2.ktx2`) into the model's directory if missing.
/// Resolves the source file by stem in `unittexturesSrc`. No-op on
/// data URIs, missing extensions, or already-present targets.
void EnsureSiblingTexture(const fs::path& glbPath,
                          const std::string& filename,
                          const fs::path& unittexturesSrc,
                          const fs::path& textureConverter) {
    if (filename.empty() || filename.find(':') != std::string::npos) return;
    const fs::path target = (glbPath.parent_path() / filename).lexically_normal();
    if (fs::exists(target)) return;
    if (target.extension() != ".ktx2") {
        SLOG(SPRING_LOG_WARNING,
            "non-ktx2 texture ref '%s' in %s — skipping",
            filename.c_str(), glbPath.filename().string().c_str());
        return;
    }
    const std::string stem = target.stem().string();
    const std::string srcTex = ResolveTextureByStem(unittexturesSrc, stem);
    if (srcTex.empty()) {
        SLOG(SPRING_LOG_WARNING,
            "texture '%s' (referenced by %s) not found in %s",
            filename.c_str(), glbPath.filename().string().c_str(),
            unittexturesSrc.string().c_str());
        return;
    }
    std::error_code ec;
    fs::create_directories(target.parent_path(), ec);
    ConvertTextureToKtx2(srcTex, target.string(), textureConverter);
}

/// Make sure every texture referenced by a freshly-written glb has a
/// sibling `.ktx2` in `unittexturesOut`. Three reference sources:
///
///   1. The glb's own `images[].uri` array — covers the diffuse (tex1)
///      for source formats whose Assimp importer records textures
///      (S3O, glTF, OBJ-with-MTL).
///   2. The Spring author-config (`<sourceModel>.<ext>.lua`) — the
///      canonical place for tex1 / tex2 in legacy archives whose model
///      format has no native texture-binding (e.g. .dae / Collada).
///   3. The sibling `.config.json` (or `.config.lua`) `tex1` / `tex2`
///      fields — covers the team-colour mask (tex2) for S3O models.
///      Source 2 supersedes this when present.
///
/// `sourceModelPath` is the original input file passed to modelimporter;
/// pass an empty path to skip source-side .lua lookup. Cheap on re-runs
/// — the per-texture early exit is a single stat() call.
void EnsureGlbTexturesAvailable(const fs::path& glbPath,
                                const fs::path& sourceModelPath,
                                const fs::path& unittexturesSrc,
                                const fs::path& unittexturesOut,
                                const fs::path& textureConverter) {
    if (unittexturesSrc.empty()) return;
    std::error_code ec;
    fs::create_directories(unittexturesOut, ec);

    // 1. glb image URIs (diffuse).
    for (const std::string& uri : ExtractGlbImageUris(glbPath)) {
        EnsureSiblingTexture(glbPath, uri, unittexturesSrc, textureConverter);
    }

    // 2 + 3. tex1 / tex2 declared in the source `.lua` author-config or
    // the model's output config sidecar (team mask).
    std::string tex1, tex2;
    ExtractConfigTextureRefs(glbPath, sourceModelPath, tex1, tex2);
    EnsureSiblingTexture(glbPath, tex1, unittexturesSrc, textureConverter);
    EnsureSiblingTexture(glbPath, tex2, unittexturesSrc, textureConverter);
}

/// Write a flat directory-listing manifest the client can use as a
/// poor man's VFS DirList. Avoids the alternative — speculatively
/// fetching every potentially-existent sidecar (e.g. `<stem>.config.lua`)
/// and getting hundreds of 404s per game start.
///
/// The format is deliberately minimal so the same writer can serve any
/// directory whose contents the client wants to enumerate (models/,
/// future weapons/, sounds/, etc.):
///
///   { "version": 1, "files": ["a.glb", "a.config.json", ...] }
///
/// Files are sorted for stable diffs and predictable cache hits. Only
/// regular files in the directory itself are listed (no recursion);
/// nested directories will get their own manifest if/when the client
/// learns to enumerate them.
// Walk `dir` (recursive when `recursive` is true; otherwise just direct
// children) and return every regular filename, sorted, with paths
// relative to `dir`. Used by the manifest writer.
std::vector<std::string> ListFiles(const fs::path& dir, bool recursive) {
    std::vector<std::string> out;
    std::error_code ec;
    if (!fs::exists(dir, ec) || !fs::is_directory(dir, ec)) return out;

    auto handle = [&](const fs::directory_entry& entry) {
        if (!entry.is_regular_file(ec)) return;
        const std::string rel = fs::relative(entry.path(), dir, ec).string();
        if (rel.empty()) return;
        if (rel == "manifest.json") return;
        // Use forward slashes regardless of host OS so manifest
        // entries match the relative paths the client will probe.
        std::string norm = rel;
        for (auto& c : norm) if (c == '\\') c = '/';
        out.push_back(std::move(norm));
    };

    if (recursive) {
        for (const auto& entry : fs::recursive_directory_iterator(dir, ec)) {
            if (ec) break;
            handle(entry);
        }
    } else {
        for (const auto& entry : fs::directory_iterator(dir, ec)) {
            if (ec) break;
            handle(entry);
        }
    }
    std::sort(out.begin(), out.end());
    return out;
}

void WriteDirManifest(const fs::path& dir, bool recursive) {
    std::error_code ec;
    if (!fs::exists(dir, ec) || !fs::is_directory(dir, ec)) return;

    std::vector<std::string> names = ListFiles(dir, recursive);

    std::string out = "{\n  \"version\": 1,\n  \"files\": [";
    for (size_t i = 0; i < names.size(); ++i) {
        if (i > 0) out += ',';
        out += "\n    \"";
        // JSON-escape: backslash, quote, control chars. Filenames
        // realistically contain none of these but the encoder needs
        // to be honest about its output.
        for (char c : names[i]) {
            if (c == '"' || c == '\\') { out += '\\'; out += c; }
            else if (static_cast<unsigned char>(c) < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            } else {
                out += c;
            }
        }
        out += '"';
    }
    out += "\n  ]\n}\n";

    const fs::path manifestPath = dir / "manifest.json";
    std::ofstream f(manifestPath, std::ios::binary | std::ios::trunc);
    if (!f) {
        SLOG(SPRING_LOG_WARNING, "failed to open manifest %s for writing",
            manifestPath.string().c_str());
        return;
    }
    f << out;
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
/// modelimporter rewrites every texture URI in the emitted glb to
/// `.ktx2` (the only legal value for `--texture-ext`); we then walk
/// those URIs and produce a `.ktx2` sibling under `<gameDir>/unittextures/`
/// for each one.
int ConvertModels(const fs::path& gameDir, const std::string& gameId,
                  const fs::path& modelImporterBin, bool force) {
    const fs::path source = ResolveSubDir(gameDir, "objects3d");
    if (source.empty()) {
        SLOG(SPRING_LOG_INFO, "%s: no objects3d/ directory, skipping model conversion",
            gameDir.string().c_str());
        return 0;
    }

    const fs::path unittexturesSrc = ResolveSubDir(gameDir, "unittextures");
    const fs::path modelsOut = gameDir / "models";
    const fs::path textureConverter = TEXTURECONVERTER_BINARY_PATH;
    std::error_code ec;
    fs::create_directories(modelsOut, ec);

    int converted = 0, skipped = 0, failed = 0;
    for (const auto& entry : fs::recursive_directory_iterator(source)) {
        if (!entry.is_regular_file()) continue;
        if (!IsModelFile(entry.path())) continue;

        const std::string stem = entry.path().stem().string();
        const fs::path outPath = modelsOut / (stem + ".glb");
        const fs::path jsonConfigPath = modelsOut / (stem + ".config.json");

        // mtime check: skip if the output is newer than the source.
        // Also force a rebuild if the sibling .config.json is stale —
        // schema bumps inside modelimporter (e.g. when a new field is
        // extracted from sources we used to ignore) need a regeneration
        // even when the .glb itself is current. modelimporter exposes
        // its current schema version via the constant baked into every
        // emitted file as `configVersion`.
        constexpr int kMinAcceptableConfigVersion = 4;
        bool needsRebuild = true;
        if (!force && fs::exists(outPath)) {
            const auto srcTime = fs::last_write_time(entry.path(), ec);
            const auto dstTime = fs::last_write_time(outPath, ec);
            if (!ec && dstTime >= srcTime) {
                needsRebuild = false;
            }
        }
        // A missing .config.json (e.g. user deleted it, or an interrupted
        // earlier run) is reason enough to rebuild even when the .glb
        // mtime check says we're current — the client manifest entry will
        // otherwise point at a phantom file and produce a 404.
        if (!needsRebuild && !fs::exists(jsonConfigPath)) {
            needsRebuild = true;
        }
        if (!needsRebuild && fs::exists(jsonConfigPath)) {
            std::ifstream in(jsonConfigPath, std::ios::binary);
            if (in) {
                const std::string contents{
                    std::istreambuf_iterator<char>(in),
                    std::istreambuf_iterator<char>()};
                int version = -1;
                size_t k = contents.find("\"configVersion\"");
                if (k != std::string::npos) {
                    size_t colon = contents.find(':', k);
                    if (colon != std::string::npos) {
                        size_t p = colon + 1;
                        while (p < contents.size() && std::isspace(
                                static_cast<unsigned char>(contents[p]))) ++p;
                        version = 0;
                        bool any = false;
                        while (p < contents.size() && std::isdigit(
                                static_cast<unsigned char>(contents[p]))) {
                            version = version * 10 + (contents[p] - '0');
                            ++p;
                            any = true;
                        }
                        if (!any) version = -1;
                    }
                }
                if (version < kMinAcceptableConfigVersion) {
                    needsRebuild = true;
                }
            }
        }

        if (needsRebuild) {
            // modelimporter defaults --texture-ext to `ktx2`; pass it
            // explicitly anyway so a future change to the default is
            // caught here rather than producing a glb with stale URIs.
            // No --texture-prefix: glb URIs stay as bare filenames so
            // they resolve to siblings in models/. Babylon's glTF
            // loader rejects URIs containing `..` per the glTF spec.
            std::vector<std::string> argv = {
                modelImporterBin.string(),
                "--texture-ext", "ktx2",
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
        // (per-URI early skip when the .ktx2 already exists). Output
        // dir is models/ (sibling of the glb) — Babylon's glTF loader
        // rejects URIs containing `..`, so glb URIs stay as bare
        // filenames and resolve against models/. The source path lets
        // the texture extractor consult the `<modelname>.<ext>.lua`
        // Spring author-config for tex1/tex2 on formats Assimp can't
        // read those out of (notably .dae).
        EnsureGlbTexturesAvailable(outPath, entry.path(),
                                   unittexturesSrc, modelsOut,
                                   textureConverter);
    }

    // Refresh the directory manifest after every run — even on a
    // re-run that converts zero files, an author may have dropped a
    // hand-authored `<stem>.config.lua` next to the existing outputs
    // and the client needs to learn it exists without speculative
    // 404-prone fetches.
    WriteDirManifest(modelsOut);

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
        "  --skip-projectile-textures\n"
        "                      Do not transcode bitmaps under bitmaps/ to\n"
        "                      KTX2 in projectiletextures/. Useful when\n"
        "                      the textures are already cached.\n"
        "  --skip-audio        Do not re-encode source audio to Opus-in-\n"
        "                      WebM. Useful when audioconverter is\n"
        "                      unavailable (ffmpeg not installed) or\n"
        "                      the audio outputs are already cached.\n"
        "  --skip-tdf          Do not convert legacy weapons/*.tdf to\n"
        "                      sibling .lua files.\n"
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
    bool skipProjectileTextures = false;
    bool skipAudio = false;
    bool skipTdf = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--force") force = true;
        else if (arg == "--skip-models") skipModels = true;
        else if (arg == "--skip-ai") skipAI = true;
        else if (arg == "--skip-projectile-textures") skipProjectileTextures = true;
        else if (arg == "--skip-audio") skipAudio = true;
        else if (arg == "--skip-tdf") skipTdf = true;
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

    if (!skipTdf) {
        failed += ConvertTdfs(gameDir, force);
    }

    if (!skipModels) {
        failed += ConvertModels(gameDir, gameId, modelImporterBin, force);
    }

    if (!skipProjectileTextures) {
        failed += ConvertProjectileTextures(gameDir, fs::path(dataDir), force);
    }

    if (!skipAudio) {
        failed += ConvertAudio(gameDir, force);
    }

    if (!skipAI) {
        MigrateAIs(gameDir);
    }

    SLOG(SPRING_LOG_NOTICE, "done (%d failures)", failed);
    springlog_shutdown();
    return failed == 0 ? 0 : 1;
}
