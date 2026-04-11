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
        std::fprintf(stderr, "[gameconverter] failed to open %s for writing\n",
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
        std::fprintf(stderr,
            "[gameconverter] %s: no modinfo.lua found — skipping game.config.lua\n",
            gameDir.string().c_str());
        return false;
    }

    const fs::path outPath = gameDir / "game.config.lua";
    if (fs::exists(outPath) && !force) {
        std::fprintf(stderr,
            "[gameconverter] %s: game.config.lua already exists (use --force to overwrite)\n",
            gameDir.string().c_str());
        return true;
    }

    if (!WriteFileText(outPath, kGameConfigTemplate))
        return false;

    std::fprintf(stderr, "[gameconverter] wrote %s\n", outPath.string().c_str());
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
        std::fprintf(stderr,
            "[gameconverter] %s: no modoptions.lua (empty lobby options)\n",
            gameDir.string().c_str());
    }

    const fs::path outPath = gameDir / "lobby.config.lua";
    if (fs::exists(outPath) && !force) {
        std::fprintf(stderr,
            "[gameconverter] %s: lobby.config.lua already exists (use --force to overwrite)\n",
            gameDir.string().c_str());
        return true;
    }

    if (!WriteFileText(outPath, kLobbyConfigTemplate))
        return false;

    std::fprintf(stderr, "[gameconverter] wrote %s\n", outPath.string().c_str());
    return true;
}

// ---------------------------------------------------------------
// Step 3: model conversion via modelimporter
// ---------------------------------------------------------------

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

/// Walk every configured model root under `gameDir` and run
/// modelimporter on every model file we find, writing the output
/// under `data/games/<gameId>/models/<stem>.glb`. Mirrors what
/// `GameProcessor::Process` does in the lobby but lives in a
/// standalone tool so authors can run it offline.
int ConvertModels(const fs::path& gameDir, const std::string& gameId,
                  const fs::path& modelImporterBin, bool force) {
    // Single model root for now — objects3d/. Legacy Spring games
    // also ship features/ meshes and a handful of odd special
    // cases, but objects3d/ is the canonical unit-model folder and
    // covers both papertanks and zk.
    const fs::path source = ResolveSubDir(gameDir, "objects3d");
    if (source.empty()) {
        std::fprintf(stderr,
            "[gameconverter] %s: no objects3d/ directory, skipping model conversion\n",
            gameDir.string().c_str());
        return 0;
    }

    const fs::path outRoot = fs::path("data/games") / gameId / "models";
    std::error_code ec;
    fs::create_directories(outRoot, ec);

    int converted = 0, skipped = 0, failed = 0;
    for (const auto& entry : fs::recursive_directory_iterator(source)) {
        if (!entry.is_regular_file()) continue;
        if (!IsModelFile(entry.path())) continue;

        const std::string stem = entry.path().stem().string();
        const fs::path outPath = outRoot / (stem + ".glb");

        // mtime check: skip if the output is newer than the source
        // unless the user passed --force. Same policy as
        // GameProcessor, just re-implemented here so the CLI
        // doesn't depend on any lobby code.
        if (!force && fs::exists(outPath)) {
            const auto srcTime = fs::last_write_time(entry.path(), ec);
            const auto dstTime = fs::last_write_time(outPath, ec);
            if (!ec && dstTime >= srcTime) {
                skipped++;
                continue;
            }
        }

        std::vector<std::string> argv = {
            modelImporterBin.string(),
            "--texture-ext", "png",
            entry.path().string(),
            outPath.string(),
        };
        std::string output;
        if (RunCommand(argv, output)) {
            converted++;
        } else {
            failed++;
            std::fprintf(stderr,
                "[gameconverter] modelimporter failed on %s\n%s\n",
                entry.path().string().c_str(), output.c_str());
        }
    }

    std::fprintf(stderr,
        "[gameconverter] %s: models %d converted, %d up-to-date, %d failed\n",
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
        std::fprintf(stderr,
            "[gameconverter] %s: ai.config.lua already exists, leaving alone\n",
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
    std::fprintf(stderr, "[gameconverter] wrote %s\n", outPath.string().c_str());
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
        std::fprintf(stderr,
            "[gameconverter] %s: no ai/ directory, skipping AI migration\n",
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
                    std::fprintf(stderr,
                        "[gameconverter] failed to move %s → %s: %s\n",
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

    std::fprintf(stderr,
        "[gameconverter] %s: AI migration — %d flat .lua moved, %d folder(s) stubbed\n",
        gameDir.string().c_str(), flatMoved, folderStubbed);
}

// ---------------------------------------------------------------
// CLI
// ---------------------------------------------------------------

void PrintUsage(const char* argv0) {
    std::fprintf(stderr,
        "gameconverter — prepare a legacy Spring-archive game for spring-web.\n"
        "\n"
        "usage: %s [options] <game-dir>\n"
        "\n"
        "  <game-dir>   path to a game archive root, e.g. content/games/papertanks.\n"
        "\n"
        "options:\n"
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
        "\n"
        "Each step is idempotent: re-running the tool on a converted game\n"
        "is a no-op unless --force is passed or a source file changed.\n",
        argv0);
}

} // namespace

int main(int argc, char* argv[]) {
    std::string gameDirArg;
    std::string modelImporterArg;
    bool force = false;
    bool skipModels = false;
    bool skipAI = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--force") force = true;
        else if (arg == "--skip-models") skipModels = true;
        else if (arg == "--skip-ai") skipAI = true;
        else if (arg == "--modelimporter" && i + 1 < argc) modelImporterArg = argv[++i];
        else if (arg == "-h" || arg == "--help") { PrintUsage(argv[0]); return 0; }
        else if (!arg.empty() && arg[0] == '-') {
            std::fprintf(stderr, "[gameconverter] unknown option: %s\n", arg.c_str());
            PrintUsage(argv[0]);
            return 2;
        }
        else gameDirArg = arg;
    }

    if (gameDirArg.empty()) {
        PrintUsage(argv[0]);
        return 2;
    }

    const fs::path gameDir = fs::absolute(gameDirArg);
    if (!fs::exists(gameDir) || !fs::is_directory(gameDir)) {
        std::fprintf(stderr, "[gameconverter] not a directory: %s\n",
            gameDir.string().c_str());
        return 1;
    }

    const std::string gameId = ToLower(gameDir.filename().string());
    std::fprintf(stderr, "[gameconverter] processing game '%s' at %s\n",
        gameId.c_str(), gameDir.string().c_str());

    // Resolve the modelimporter path. The default location is
    // whichever spring-web build tree we're running out of; the
    // tool doesn't ship as a PATH-installable binary, so assuming
    // the CI-style build layout keeps the CLI short. --modelimporter
    // overrides this for authors running from a non-standard dir.
    fs::path modelImporterBin;
    if (!modelImporterArg.empty()) {
        modelImporterBin = modelImporterArg;
    } else if (fs::exists("build/release/tools/modelimporter/modelimporter")) {
        modelImporterBin = "build/release/tools/modelimporter/modelimporter";
    } else {
        modelImporterBin = "build/debug/tools/modelimporter/modelimporter";
    }
    if (!skipModels && !fs::exists(modelImporterBin)) {
        std::fprintf(stderr,
            "[gameconverter] modelimporter not found at %s — build it first,\n"
            "                or pass --modelimporter <path> / --skip-models\n",
            modelImporterBin.string().c_str());
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

    std::fprintf(stderr, "[gameconverter] done (%d failures)\n", failed);
    return failed == 0 ? 0 : 1;
}
