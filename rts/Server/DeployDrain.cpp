#include "DeployDrain.h"

#include <array>
#include <cctype>
#include <cstdio>
#include <string>

namespace deploydrain {

DrainAction DecideDrainAction(const DrainTarget& t) {
    if (!t.alive || t.pid <= 0)
        return DrainAction::None;
    // Every kind. See the header for why this is NOT ActionOnLobbyExit.
    return DrainAction::Signal;
}

const char* ToString(DrainOutcome o) {
    switch (o) {
        case DrainOutcome::NotRunning:              return "not_running";
        case DrainOutcome::Checkpointed:            return "checkpointed";
        case DrainOutcome::ExitedWithoutCheckpoint: return "exited_without_checkpoint";
        case DrainOutcome::KilledAfterTimeout:      return "killed_after_timeout";
        case DrainOutcome::StillAlive:              return "still_alive";
    }
    return "unknown";
}

DrainOutcome ClassifyDrainExit(bool exited, bool escalated,
                               const warresume::SnapshotFacts& before,
                               const warresume::SnapshotFacts& after) {
    if (!exited)
        return DrainOutcome::StillAlive;
    if (escalated)
        // A SIGKILLed process took no checkpoint, whatever is in the store —
        // and if a row DID appear it came from the SIGTERM it ignored for too
        // long, which is not a state anything should call clean.
        return DrainOutcome::KilledAfterTimeout;
    // A *fresh* exit checkpoint: written by this signal, not left over from an
    // earlier hibernation. `takenAt` alone is too coarse (whole seconds, and a
    // war can hibernate twice in one second on a fast map), so the frame or the
    // timestamp moving both count, and a first-ever checkpoint counts by `has`.
    const bool fresh = after.fromHibernation &&
                       (!before.has || after.frame != before.frame ||
                        after.takenAt != before.takenAt ||
                        after.label != before.label);
    return fresh ? DrainOutcome::Checkpointed
                 : DrainOutcome::ExitedWithoutCheckpoint;
}

DrainResult BuildResult(const DrainTarget& t, bool exited, bool escalated,
                        int64_t waitedMs,
                        const warresume::SnapshotFacts& before,
                        const warresume::SnapshotFacts& after) {
    DrainResult r;
    r.roomId = t.roomId;
    r.kind = t.kind;
    r.pid = t.pid;
    r.waitedMs = waitedMs;
    if (DecideDrainAction(t) == DrainAction::None) {
        r.outcome = DrainOutcome::NotRunning;
        return r;
    }
    r.outcome = ClassifyDrainExit(exited, escalated, before, after);
    if (r.outcome == DrainOutcome::Checkpointed) {
        r.frame = after.frame;
        r.label = after.label;
    }
    // Loss is a property of what the process was FOR. A skirmish's world is one
    // bounded match nobody resumes, and a replay is a recording being replayed —
    // neither is lost by exiting without a snapshot. A war is.
    const bool resumableWorld =
        t.kind == SessionKind::PersistentWar && !t.isReplay;
    r.lossy = resumableWorld && (r.outcome == DrainOutcome::ExitedWithoutCheckpoint ||
                                 r.outcome == DrainOutcome::KilledAfterTimeout ||
                                 r.outcome == DrainOutcome::StillAlive);
    return r;
}

std::string Describe(const DrainResult& r) {
    const char* what = r.kind == SessionKind::PersistentWar ? "war" : "skirmish";
    std::string s = std::string(what) + " room " + std::to_string(r.roomId);
    switch (r.outcome) {
        case DrainOutcome::NotRunning:
            return s + ": no live server — nothing to drain";
        case DrainOutcome::Checkpointed:
            return s + ": checkpointed at frame " + std::to_string(r.frame) +
                   " (" + r.label + ") and exited after " +
                   std::to_string(r.waitedMs) + " ms";
        case DrainOutcome::ExitedWithoutCheckpoint:
            return s + ": exited after " + std::to_string(r.waitedMs) +
                   " ms with no exit checkpoint" +
                   (r.lossy ? " — ITS WORLD IS LOST" : " (nothing to save)");
        case DrainOutcome::KilledAfterTimeout:
            return s + ": ignored SIGTERM for " + std::to_string(r.waitedMs) +
                   " ms and was SIGKILLed" +
                   (r.lossy ? " — ITS WORLD IS LOST" : "");
        case DrainOutcome::StillAlive:
            return s + ": STILL RUNNING after " + std::to_string(r.waitedMs) +
                   " ms — do not replace the binary";
    }
    return s + ": unknown outcome";
}

DrainSummary Summarise(const std::vector<DrainResult>& results) {
    DrainSummary s;
    for (const auto& r : results) {
        if (r.outcome == DrainOutcome::NotRunning)
            continue;
        ++s.servers;
        if (r.outcome == DrainOutcome::Checkpointed) ++s.checkpointed;
        if (r.outcome == DrainOutcome::KilledAfterTimeout) ++s.killed;
        if (r.outcome == DrainOutcome::StillAlive) { ++s.stillAlive; s.drained = false; }
        if (r.lossy) ++s.lossy;
    }
    return s;
}

std::string Describe(const DrainSummary& s) {
    if (s.servers == 0)
        return "drain: no game servers were running — the machine is already "
               "drained";
    std::string out = "drain: " + std::to_string(s.servers) +
                      " server(s) signalled, " + std::to_string(s.checkpointed) +
                      " checkpointed";
    if (s.killed > 0)  out += ", " + std::to_string(s.killed) + " SIGKILLed";
    if (s.lossy > 0)   out += ", " + std::to_string(s.lossy) + " WORLD(S) LOST";
    if (!s.drained)
        out += ", " + std::to_string(s.stillAlive) +
               " STILL RUNNING — do not replace the binary";
    return out;
}

// ───────────────────── probing the binary's engine hash ─────────────────────

std::string ParseEngineHashOutput(const std::string& out) {
    // Exactly one 16-hex token, ignoring surrounding whitespace. Anything else
    // is not an answer: an old binary treats the flag as unknown and either
    // prints nothing or starts booting, and both must read as "cannot check".
    size_t b = 0, e = out.size();
    while (b < e && std::isspace(static_cast<unsigned char>(out[b]))) ++b;
    while (e > b && std::isspace(static_cast<unsigned char>(out[e - 1]))) --e;
    const std::string tok = out.substr(b, e - b);
    if (tok.size() != 16)
        return std::string();
    for (char c : tok) {
        const bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!hex) return std::string();
    }
    return tok;
}

std::string ProbeServerEngineHash(const std::string& bin, std::string& err) {
    err.clear();
    if (bin.empty()) { err = "no server binary"; return std::string(); }
    // 2>/dev/null: an old binary's usage/log noise on stderr is not an answer
    // and must not be parsed as one.
    const std::string cmd = "'" + bin + "' --print-engine-hash 2>/dev/null";
    FILE* p = popen(cmd.c_str(), "r");
    if (p == nullptr) { err = "popen failed"; return std::string(); }
    std::string out;
    std::array<char, 256> buf{};
    while (std::fgets(buf.data(), static_cast<int>(buf.size()), p) != nullptr)
        out += buf.data();
    const int rc = pclose(p);
    const std::string hash = ParseEngineHashOutput(out);
    if (hash.empty())
        err = "no engine hash from '" + bin + "' (exit " + std::to_string(rc) +
              ") — it is probably older than --print-engine-hash";
    return hash;
}

}  // namespace deploydrain
