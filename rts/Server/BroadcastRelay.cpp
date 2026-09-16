#include "BroadcastRelay.h"

#include <algorithm>
#include <unordered_map>

namespace broadcast {

namespace {
constexpr uint8_t kStateClass = 1;  // StreamClass::State — see WebTransportServer.h
constexpr float kMinSpeed = 0.1f;
constexpr float kMaxSpeed = 8.0f;
}  // namespace

void BroadcastCursor::Attach(Reader* r, uint64_t startWallMs, uint64_t nowMs) {
    reader = r;
    virtualWallMs = startWallMs;
    lastPumpMs = nowMs;
    currentFrame = 0;
    if (reader != nullptr) reader->ScanIndex();
}

void BroadcastCursor::SetSpeed(float s) {
    speed = std::clamp(s, kMinSpeed, kMaxSpeed);
}

bool BroadcastCursor::ReadDue(uint64_t limitWallMs, Emission& out) {
    // Peek-and-restore: `Reader::Next` has no un-read, so a record stamped
    // past the limit is put back by rewinding the cursor to where it started.
    // It is not dropped — it is not due YET, and on a paced feed "not yet" is
    // the normal answer several times a second.
    const uint64_t before = reader->Offset();
    Record rec;
    if (!reader->Next(rec)) return false;
    if (rec.wallMs > limitWallMs) {
        reader->SeekTo(before);
        return false;
    }
    out.cls    = rec.cls;
    out.lane   = rec.lane;
    out.frame  = rec.frame;
    out.wallMs = rec.wallMs;
    out.payload = std::move(rec.payload);
    return true;
}

PumpStop BroadcastCursor::Pump(uint64_t nowMs, uint64_t liveEdgeMs,
                               std::vector<Emission>& out, size_t maxRecords) {
    if (reader == nullptr) return PumpStop::AtTail;

    const uint64_t elapsedReal = nowMs > lastPumpMs ? nowMs - lastPumpMs : 0;
    lastPumpMs = nowMs;
    if (paused) return PumpStop::Paused;

    virtualWallMs += static_cast<uint64_t>(elapsedReal * speed);
    // Park AT the edge rather than past it. A watcher who idles there stays
    // exactly `delay` behind; letting the virtual clock run on would make them
    // fall further behind by however long they idled.
    const bool clampedToEdge = virtualWallMs >= liveEdgeMs;
    if (clampedToEdge) virtualWallMs = liveEdgeMs;

    reader->Rescan();
    const uint64_t limit = std::min(virtualWallMs, liveEdgeMs);
    for (size_t n = 0; n < maxRecords; ++n) {
        Emission e;
        if (!ReadDue(limit, e)) return clampedToEdge ? PumpStop::AtEdge
                                                     : PumpStop::AtTail;
        currentFrame = e.frame;
        out.push_back(std::move(e));
    }
    return PumpStop::Budget;
}

void BroadcastCursor::CollapseCatchUp(std::vector<Emission>& span) {
    // Last-State-wins, per lane. Every other tier is a cause the client cannot
    // reconstruct from a later message (a unit created, a LOS grid, a def
    // blob), so it goes out whole and in order.
    std::unordered_map<uint32_t, size_t> lastStateAt;
    for (size_t i = 0; i < span.size(); ++i)
        if (span[i].cls == kStateClass) lastStateAt[span[i].lane] = i;

    std::vector<Emission> kept;
    kept.reserve(span.size());
    for (size_t i = 0; i < span.size(); ++i) {
        if (span[i].cls == kStateClass) {
            const auto it = lastStateAt.find(span[i].lane);
            if (it == lastStateAt.end() || it->second != i) continue;
        }
        kept.push_back(std::move(span[i]));
    }
    span = std::move(kept);
}

uint64_t BroadcastCursor::Seek(uint64_t targetWallMs, uint64_t liveEdgeMs,
                               std::vector<Emission>& out) {
    if (reader == nullptr) return virtualWallMs;
    reader->Rescan();
    reader->ScanIndex();
    const auto& kfs = reader->Keyframes();

    // Clamp into what the delay allows. A seek past the edge is the ordinary
    // case (a watcher drags the bar to "now"), so it is clamped, not refused.
    if (!kfs.empty() && targetWallMs < kfs.front().wallMs)
        targetWallMs = kfs.front().wallMs;
    if (targetWallMs > liveEdgeMs) targetWallMs = liveEdgeMs;

    // Nearest keyframe at or before the target: a `K` is a re-emitted join
    // bundle, so it is the only offset a watcher can be dropped at and see a
    // whole world.
    const Keyframe* kf = nullptr;
    for (const auto& k : kfs) {
        if (k.wallMs > targetWallMs) break;
        kf = &k;
    }
    if (kf == nullptr) {
        // No keyframe at or before the target. Either the log has none yet, or
        // — the case that matters — the delay has not reached the first one:
        // a mission that started ten minutes ago is entirely past a one-hour
        // live edge. Emit NOTHING and park. Falling back to the first keyframe
        // here would have served the opening instant of a mission the delay
        // says nobody may see, which is the one failure this class exists to
        // prevent.
        virtualWallMs = targetWallMs;
        return targetWallMs;
    }
    reader->SeekTo(kf->offset);

    std::vector<Emission> span;
    for (;;) {
        Emission e;
        if (!ReadDue(targetWallMs, e)) break;
        currentFrame = e.frame;
        span.push_back(std::move(e));
    }
    CollapseCatchUp(span);
    out.insert(out.end(), std::make_move_iterator(span.begin()),
               std::make_move_iterator(span.end()));

    virtualWallMs = targetWallMs;
    return targetWallMs;
}

void LiveEdgeTracker::Advance(uint64_t liveEdgeMs) {
    if (reader == nullptr) return;
    reader->Rescan();
    for (;;) {
        const uint64_t before = reader->Offset();
        Record rec;
        if (!reader->Next(rec)) return;
        if (rec.wallMs > liveEdgeMs) {
            reader->SeekTo(before);
            return;
        }
        frame  = rec.frame;
        wallMs = rec.wallMs;
    }
}

namespace {
bool gRelaying = false;
int  gDelaySec = kMinBroadcastDelaySec;
}  // namespace

bool IsRelaying() { return gRelaying; }
void SetRelaying(bool on) { gRelaying = on; }
int  DelaySeconds() { return gDelaySec; }
void SetDelaySeconds(int sec) { gDelaySec = sec; }

}  // namespace broadcast
