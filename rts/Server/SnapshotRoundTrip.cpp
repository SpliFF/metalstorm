#include "Server/SnapshotRoundTrip.h"

#include <algorithm>
#include <cerrno>
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

    if (armA_.size() != armB_.size()) {
        result_.failure = "arm A recorded " + std::to_string(armA_.size()) +
                          " hashes, arm B " + std::to_string(armB_.size());
    } else if (static_cast<int64_t>(armA_.size()) != cfg_.ticks) {
        result_.failure = "expected " + std::to_string(cfg_.ticks) +
                          " hashes per arm, recorded " +
                          std::to_string(armA_.size());
    } else if (result_.firstDivergentFrame >= 0) {
        result_.failure = "state hash diverged at frame " +
                          std::to_string(result_.firstDivergentFrame);
    } else if (!result_.restoreRecaptureIdentical) {
        // Every tick agreed and the state the hash does not cover still moved:
        // capture→apply→capture is not idempotent, which is a capture bug the
        // 100 ticks are blind to.
        result_.failure = "the checkpoint re-captured from the restored world "
                          "differs from the checkpoint that was applied";
    } else if (!result_.terminalPayloadIdentical) {
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
    if (!result_.pass)
        out += " - " + result_.failure;
    return out;
}

}  // namespace snapshotrt
