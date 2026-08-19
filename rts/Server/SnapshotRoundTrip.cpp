#include "Server/SnapshotRoundTrip.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>

namespace snapshotrt {

namespace {

// The comparison is only worth as much as its bounds: a spec that asks for a
// checkpoint at frame 0 compares two worlds that have not started, and a spec
// that asks for a million ticks turns a CI job into a soak. Both are refused
// at parse time with a reason rather than silently honoured.
constexpr int64_t kMaxTicks = 1000000;

bool ParseInt(const std::string& s, int64_t& out)
{
    if (s.empty()) return false;
    for (char c : s)
        if (c < '0' || c > '9') return false;
    errno = 0;
    out = std::strtoll(s.c_str(), nullptr, 10);
    return errno == 0;
}

}  // namespace

bool ParseSpec(const std::string& spec, Config& out, std::string& err)
{
    const size_t colon = spec.find(':');
    const std::string frameStr = spec.substr(0, colon);
    const std::string tickStr =
        (colon == std::string::npos) ? std::string() : spec.substr(colon + 1);

    int64_t frame = 0;
    if (!ParseInt(frameStr, frame)) {
        err = "expected <frame>[:<ticks>], got '" + spec + "'";
        return false;
    }
    if (frame <= 0) {
        // Frame 0 is before GameStart: no units, no gadget state, nothing the
        // walk captures is populated yet. A round-trip there passes on an
        // empty world, which is the one result this test must never produce.
        err = "checkpoint frame must be > 0 (frame 0 is before GameStart — the "
              "world is empty and the comparison is vacuous)";
        return false;
    }

    int64_t ticks = 100;
    if (colon != std::string::npos) {
        if (!ParseInt(tickStr, ticks)) {
            err = "expected <frame>[:<ticks>], got '" + spec + "'";
            return false;
        }
        if (ticks <= 0 || ticks > kMaxTicks) {
            err = "tick count must be in [1, " + std::to_string(kMaxTicks) + "]";
            return false;
        }
    }

    out.enabled = true;
    out.atFrame = frame;
    out.ticks = ticks;
    return true;
}

Step Controller::OnFrame(int64_t frame)
{
    Step s;
    if (!cfg_.enabled || phase_ == Phase::Done)
        return s;

    // The server loop iterates faster than it ticks (pacing, pre-GameStart,
    // paused). Counting loop passes rather than sim frames would compare arms
    // of different lengths and blame the serializer for the scheduler.
    if (frame == lastFrame_)
        return s;

    switch (phase_) {
        case Phase::Idle: {
            lastFrame_ = frame;
            if (frame < cfg_.atFrame)
                return s;
            startFrame_ = frame;
            phase_ = Phase::ArmA;
            s.capture = true;
            return s;
        }
        case Phase::ArmA:
        case Phase::ArmB: {
            std::vector<uint64_t>& arm =
                (phase_ == Phase::ArmA) ? armA_ : armB_;
            const int64_t expect =
                startFrame_ + static_cast<int64_t>(arm.size()) + 1;
            if (frame != expect) {
                // A skipped or repeated frame makes the two tracks
                // incomparable — and it is also how a caller that forgot to
                // call RecordHash() is caught, because the expectation stops
                // advancing while the sim does not.
                Fail("arm " + std::string(phase_ == Phase::ArmA ? "A" : "B") +
                     " expected frame " + std::to_string(expect) + ", got " +
                     std::to_string(frame) +
                     " (the sim skipped a tick, or a recorded hash was dropped)");
                return s;
            }
            lastFrame_ = frame;
            s.record = true;
            if (static_cast<int64_t>(arm.size()) + 1 >= cfg_.ticks) {
                s.captureTerminal = true;
                if (phase_ == Phase::ArmA)
                    s.restore = true;
                else
                    s.finish = true;
            }
            return s;
        }
        case Phase::Done:
            return s;
    }
    return s;
}

void Controller::SetCheckpoint(std::vector<uint8_t> bytes)
{
    checkpoint_ = std::move(bytes);
}

void Controller::RecordHash(uint64_t hash)
{
    if (phase_ == Phase::ArmA)
        armA_.push_back(hash);
    else if (phase_ == Phase::ArmB)
        armB_.push_back(hash);
}

void Controller::SetTerminalPayload(std::vector<uint8_t> bytes)
{
    if (phase_ == Phase::ArmA) {
        terminalA_ = std::move(bytes);
        return;
    }
    if (phase_ != Phase::ArmB)
        return;

    // Arm B's terminal payload is the last input the comparison needs, so the
    // verdict is reached here rather than waiting for the caller to ask —
    // Result() is valid the moment the caller sees Step::finish.
    terminalB_ = std::move(bytes);
    result_.terminalBytes = terminalA_.size();
    result_.terminalPayloadIdentical = (terminalA_ == terminalB_);
    if (!result_.terminalPayloadIdentical) {
        const size_t n = std::min(terminalA_.size(), terminalB_.size());
        size_t i = 0;
        while (i < n && terminalA_[i] == terminalB_[i]) ++i;
        result_.firstDifferentByte = static_cast<int64_t>(i);
    }
    // The verdict waits for Finish(): under the default bar it is the roster
    // and vitals comparison, not the bytes, that decides — and only the caller
    // can decode a payload into units.
}

void Controller::Finish(const Divergence& d)
{
    if (phase_ == Phase::Done)
        return;
    result_.divergence = d;
    Finalise();
}

void Controller::OnRestored(int64_t frameAfterRestore,
                            const std::vector<uint8_t>& recaptured)
{
    // The frame counter is itself captured state (the `globals` section). If
    // it did not rewind, the restore did not restore, and arm B would be a
    // second copy of nothing.
    restoreOk_ = (frameAfterRestore == startFrame_);
    recaptureOk_ = (recaptured == checkpoint_);
    if (!restoreOk_) {
        Fail("restore left the sim at frame " + std::to_string(frameAfterRestore) +
             ", not the checkpoint's " + std::to_string(startFrame_));
        return;
    }
    phase_ = Phase::ArmB;
    lastFrame_ = frameAfterRestore;
}

void Controller::Fail(std::string reason)
{
    if (phase_ == Phase::Done)
        return;
    phase_ = Phase::Done;
    result_.ran = false;
    result_.pass = false;
    result_.failure = std::move(reason);
    result_.startFrame = startFrame_;
    result_.endFrame = (startFrame_ >= 0) ? startFrame_ + cfg_.ticks : -1;
    result_.checkpointBytes = checkpoint_.size();
}

void Controller::Finalise()
{
    phase_ = Phase::Done;
    result_.ran = true;
    result_.startFrame = startFrame_;
    result_.endFrame = startFrame_ + cfg_.ticks;
    result_.checkpointBytes = checkpoint_.size();
    result_.restoreRecaptureIdentical = recaptureOk_;

    const size_t n = std::min(armA_.size(), armB_.size());
    result_.hashesCompared = n;
    for (size_t i = 0; i < n; ++i) {
        if (armA_[i] != armB_[i]) {
            result_.firstDivergentFrame = startFrame_ + static_cast<int64_t>(i) + 1;
            result_.expected = armA_[i];
            result_.actual = armB_[i];
            break;
        }
    }

    result_.strict = cfg_.strict;
    const Divergence& d = result_.divergence;

    // The bars that hold under BOTH policies come first: they are statements
    // about the harness and about the restore itself, neither of which the
    // Q-P2 decision touched.
    if (armA_.size() != armB_.size()) {
        result_.failure = "arm A recorded " + std::to_string(armA_.size()) +
                          " hashes, arm B " + std::to_string(armB_.size());
    } else if (static_cast<int64_t>(armA_.size()) != cfg_.ticks) {
        result_.failure = "expected " + std::to_string(cfg_.ticks) +
                          " hashes per arm, recorded " +
                          std::to_string(armA_.size());
    } else if (!result_.restoreRecaptureIdentical) {
        // capture→apply→capture is not idempotent: a capture bug, and the one
        // bar that is about the RESTORE rather than about the continuation. It
        // caught a building being re-snapped to the build grid on every apply.
        result_.failure = "the checkpoint re-captured from the restored world "
                          "differs from the checkpoint that was applied";
    } else if (!d.measured) {
        // "The continuation was never measured" must not read as "it agreed".
        result_.failure = "the two arms' terminal units sections could not be "
                          "compared (the payloads did not decode)";
    } else if (d.onlyA != 0 || d.onlyB != 0) {
        // A unit that exists in one continuation and not the other is a
        // different world, not a different track: a kill that did not happen,
        // or a build that did.
        result_.failure = "the two arms' rosters differ — " +
                          std::to_string(d.onlyA) + " unit(s) only in arm A, " +
                          std::to_string(d.onlyB) + " only in arm B";
    } else if (d.vitals != 0) {
        // Health/experience/damage are outcomes. Movement may re-derive; who
        // got hurt may not.
        result_.failure = std::to_string(d.vitals) +
                          " unit(s) differ in vitals (health/experience/damage) "
                          "— a resumed world may re-derive movement, not combat "
                          "outcomes";
    } else if (cfg_.strict && result_.firstDivergentFrame >= 0) {
        result_.failure = "state hash diverged at frame " +
                          std::to_string(result_.firstDivergentFrame);
    } else if (cfg_.strict && !result_.terminalPayloadIdentical) {
        result_.failure = "terminal payloads differ at byte " +
                          std::to_string(result_.firstDifferentByte) +
                          " (the hash track agreed — this is state the hash "
                          "does not cover)";
    }
    result_.pass = result_.failure.empty();
}

std::string Controller::FormatVerdict() const
{
    if (!cfg_.enabled)
        return "snapshot round-trip: not requested";
    if (phase_ != Phase::Done)
        return "snapshot round-trip: INCOMPLETE - the run ended in phase " +
               std::string(phase_ == Phase::Idle ? "Idle (the checkpoint frame "
                                                   "was never reached)"
                           : phase_ == Phase::ArmA ? "ArmA" : "ArmB");
    if (!result_.ran)
        return "snapshot round-trip: FAILED - " + result_.failure;

    std::string out = "snapshot round-trip: ";
    out += result_.pass ? "PASS" : "FAILED";
    out += std::string(" [") + (result_.strict ? "strict" : "world") + " bar]";
    out += " frames " + std::to_string(result_.startFrame) + ".." +
           std::to_string(result_.endFrame) + " - " +
           std::to_string(result_.hashesCompared) + " state hashes " +
           (result_.firstDivergentFrame < 0 ? "identical" : "DIVERGED") +
           ", checkpoint " + std::to_string(result_.checkpointBytes) +
           " bytes, re-capture " +
           (result_.restoreRecaptureIdentical ? "identical" : "DIFFERS") +
           ", terminal payload (" + std::to_string(result_.terminalBytes) +
           " bytes) " +
           (result_.terminalPayloadIdentical ? "identical" : "DIFFERS");

    // The metric, printed on a PASS as well as on a failure: it is the number
    // that says how far a resumed world drifts from the one it resumed, and
    // therefore how much of Q-P2's option A is worth building. A bar that only
    // reports when it fails leaves nobody able to see the trend.
    const Divergence& d = result_.divergence;
    if (d.measured) {
        char buf[256];
        snprintf(buf, sizeof(buf),
                 ". Continuation: %zu/%zu units differ in transform (max pos "
                 "delta %.3f elmos, max heading delta %.1f deg), %zu in vitals, "
                 "roster %s",
                 d.transform, d.unitsA, d.maxPosDelta, d.maxHeadingDelta,
                 d.vitals,
                 (d.onlyA == 0 && d.onlyB == 0) ? "identical" : "DIFFERS");
        out += buf;
    } else {
        out += ". Continuation: NOT MEASURED";
    }
    if (!result_.pass)
        out += " - " + result_.failure;
    return out;
}

}  // namespace snapshotrt
