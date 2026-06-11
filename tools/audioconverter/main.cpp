// audioconverter — Opus-in-WebM producer for spring-web.
//
// One canonical on-disk format for every game audio asset: `.webm`
// (Opus inside a WebM container). The runtime never sees `.wav`,
// `.ogg`, `.mp3`, `.flac`, or `.m4a` again.
//
// Sources we accept (case-insensitive extension match):
//   - WAV/Wav/WAV - raw PCM, any sample rate, mono / stereo.
//   - OGG (Vorbis or Opus) - re-encoded to Opus for container safety.
//   - MP3 - decode + re-encode (only way to drop the baked-in priming).
//   - FLAC - decode + Opus encode.
//   - M4A / AAC - decode + Opus encode.
//
// Output is always lowercase `.webm`, regardless of the source's
// extension casing.
//
// CLI:
//   audioconverter [options] <input> <output.webm>
//
//   --category sfx|ui|music
//       Bitrate hint. sfx (default) = 64 kbps mono,
//       ui = 48 kbps mono, music = 96 kbps stereo. This is an
//       encoder-side concept and does NOT correspond to Recoil's
//       runtime channels (which are caller-determined at play
//       time).
//
//   --force
//       Re-encode even if <output> already exists and is newer
//       than <input>. The default skip-by-mtime check matches what
//       textureconverter does, so repeated content-prep runs stay
//       fast.
//
//   --log-level <debug|info|notice|warning|error>
//
// Backend: shells out to `ffmpeg` (path baked in at CMake configure
// time via FFMPEG_BINARY_PATH). Audio conversion is not optional in
// the content pipeline, so a missing ffmpeg is a configure-time
// fatal error rather than a runtime surprise.

#include "System/SpringLog/SpringLog.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
#include <system_error>
#include <vector>

#define LOG_SECTION "audio-convert"

namespace fs = std::filesystem;

#ifndef FFMPEG_BINARY_PATH
#define FFMPEG_BINARY_PATH "ffmpeg"
#endif

// ============================================================
// Encoding categories
// ============================================================

enum class Category { Sfx, Ui, Music };

struct EncodeParams {
    int bitrateKbps;
    int channels;
};

static EncodeParams ParamsFor(Category c) {
    switch (c) {
        case Category::Ui:    return {48, 1};
        case Category::Music: return {96, 2};
        case Category::Sfx:
        default:              return {64, 1};
    }
}

static const char* CategoryName(Category c) {
    switch (c) {
        case Category::Ui:    return "ui";
        case Category::Music: return "music";
        case Category::Sfx:
        default:              return "sfx";
    }
}

// ============================================================
// Helpers
// ============================================================

static std::string ToLower(std::string s) {
    for (auto& c : s)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

static bool HasAudioExtension(const fs::path& p) {
    static const char* const kExts[] = {
        ".wav", ".ogg", ".mp3", ".flac", ".m4a", ".aac",
    };
    std::string ext = ToLower(p.extension().string());
    for (const char* e : kExts) {
        if (ext == e) return true;
    }
    return false;
}

/// Run a command via popen, capture stdout+stderr for logging on
/// failure. Mirrors the helper in gameconverter.
static bool RunCommand(const std::vector<std::string>& argv,
                       std::string& output) {
    std::string cmd;
    for (size_t i = 0; i < argv.size(); ++i) {
        if (i) cmd += ' ';
        cmd += '"';
        for (char c : argv[i]) {
            // Inside double quotes the shell still expands $ and `...`
            // and honours \ — so a filename like `wILLE$T '…'.mp3`
            // would lose `$T`. Backslash-escape every char POSIX treats
            // as special within double quotes.
            if (c == '"' || c == '\\' || c == '$' || c == '`') cmd += '\\';
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
    while (std::fgets(buf, sizeof(buf), pipe) != nullptr) {
        output += buf;
    }
    int status = pclose(pipe);
    return status == 0;
}

// ============================================================
// Encode
// ============================================================

/// Invoke ffmpeg to re-encode <src> to <dst> as Opus-in-WebM at the
/// bitrate / channel count dictated by `cat`. ffmpeg overwrites
/// existing outputs (`-y`); the caller's skip-by-mtime gate decides
/// whether we got here at all.
static bool Encode(const fs::path& src, const fs::path& dst, Category cat) {
    std::error_code ec;
    fs::create_directories(dst.parent_path(), ec);

    const EncodeParams p = ParamsFor(cat);
    char bitrateArg[16];
    std::snprintf(bitrateArg, sizeof(bitrateArg), "%dk", p.bitrateKbps);
    char channelsArg[8];
    std::snprintf(channelsArg, sizeof(channelsArg), "%d", p.channels);

    std::vector<std::string> argv = {
        FFMPEG_BINARY_PATH,
        "-hide_banner",
        "-loglevel", "warning",
        "-y",
        "-i", src.string(),
        "-c:a", "libopus",
        "-application", "audio",
        "-vbr", "on",
        "-b:a", bitrateArg,
        "-ac", channelsArg,
        "-map_metadata", "-1",
        // -map 0:a:0 picks the first audio stream so video-bearing
        // M4A files (rare but legal — iTunes can stash artwork) don't
        // cause ffmpeg to try to copy a video stream into a Vorbis-
        // only WebM container.
        "-map", "0:a:0",
        dst.string(),
    };

    std::string output;
    if (!RunCommand(argv, output)) {
        SLOG(SPRING_LOG_WARNING,
            "ffmpeg failed: %s -> %s\n%s",
            src.string().c_str(), dst.string().c_str(), output.c_str());
        return false;
    }

    // ffmpeg sometimes prints warnings (e.g. "Estimating duration
    // from bitrate") on stderr even on success. Surface them at
    // debug level only.
    if (!output.empty()) {
        SLOG(SPRING_LOG_DEBUG, "ffmpeg output for %s:\n%s",
            src.string().c_str(), output.c_str());
    }
    return true;
}

// ============================================================
// CLI
// ============================================================

static void PrintUsage(const char* argv0) {
    SLOG(SPRING_LOG_NOTICE,
        "produce Opus-in-WebM audio for spring-web.\n"
        "\n"
        "usage:\n"
        "  %s [options] <input> <output.webm>\n"
        "\n"
        "Source extension is matched case-insensitively against\n"
        ".wav/.ogg/.mp3/.flac/.m4a/.aac. Output is always lowercase\n"
        ".webm.\n"
        "\n"
        "options:\n"
        "  --category sfx|ui|music   Encoder bitrate hint.\n"
        "                            sfx (default) = 64 kbps mono,\n"
        "                            ui = 48 kbps mono,\n"
        "                            music = 96 kbps stereo.\n"
        "  --force                   Re-encode even if the output is\n"
        "                            newer than the source.\n"
        "  --log-level <level>       debug/info/notice/warning/error\n",
        argv0);
}

int main(int argc, char* argv[]) {
    springlog_init("audioconverter", SPRING_LOG_OUTPUT_CONSOLE);

    std::string inputPath, outputPath;
    Category category = Category::Sfx;
    bool force = false;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "--category" && i + 1 < argc) {
            const std::string v = ToLower(argv[++i]);
            if (v == "sfx")        category = Category::Sfx;
            else if (v == "ui")    category = Category::Ui;
            else if (v == "music") category = Category::Music;
            else {
                SLOG(SPRING_LOG_ERROR, "bad --category: %s", v.c_str());
                springlog_shutdown();
                return 2;
            }
        } else if (a == "--force") {
            force = true;
        } else if (a == "--log-level" && i + 1 < argc) {
            const std::string lvl = argv[++i];
            if (lvl == "debug")        springlog_set_min_level(SPRING_LOG_DEBUG);
            else if (lvl == "info")    springlog_set_min_level(SPRING_LOG_INFO);
            else if (lvl == "notice")  springlog_set_min_level(SPRING_LOG_NOTICE);
            else if (lvl == "warning") springlog_set_min_level(SPRING_LOG_WARNING);
            else if (lvl == "error")   springlog_set_min_level(SPRING_LOG_ERROR);
        } else if (a == "-h" || a == "--help") {
            PrintUsage(argv[0]);
            springlog_shutdown();
            return 0;
        } else if (!a.empty() && a[0] == '-') {
            SLOG(SPRING_LOG_ERROR, "unknown option: %s", a.c_str());
            springlog_shutdown();
            return 2;
        } else if (inputPath.empty()) {
            inputPath = a;
        } else if (outputPath.empty()) {
            outputPath = a;
        }
    }

    if (inputPath.empty() || outputPath.empty()) {
        PrintUsage(argv[0]);
        springlog_shutdown();
        return 2;
    }

    const fs::path src = inputPath;
    fs::path dst = outputPath;

    if (!fs::exists(src)) {
        SLOG(SPRING_LOG_ERROR, "input not found: %s", src.string().c_str());
        springlog_shutdown();
        return 1;
    }

    if (!HasAudioExtension(src)) {
        SLOG(SPRING_LOG_WARNING,
            "input '%s' has an unrecognised audio extension; trying anyway",
            src.string().c_str());
    }

    // Output is always lowercase .webm. If the caller passed a path
    // ending in a different extension, normalise it — the output
    // contract is universal regardless of source casing.
    const std::string outExt = ToLower(dst.extension().string());
    if (outExt != ".webm") {
        dst.replace_extension(".webm");
    }

    // Skip if dst exists and is newer than src.
    std::error_code ec;
    if (!force && fs::exists(dst, ec)) {
        const auto srcTime = fs::last_write_time(src, ec);
        const auto dstTime = fs::last_write_time(dst, ec);
        if (!ec && dstTime >= srcTime) {
            SLOG(SPRING_LOG_INFO, "up-to-date: %s", dst.string().c_str());
            springlog_shutdown();
            return 0;
        }
        ec.clear();
    }

    SLOG(SPRING_LOG_INFO, "[%s] %s -> %s",
        CategoryName(category),
        src.string().c_str(), dst.string().c_str());

    const bool ok = Encode(src, dst, category);
    springlog_shutdown();
    return ok ? 0 : 1;
}
