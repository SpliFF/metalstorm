#include "ReplayPlayer.h"

#include <algorithm>

namespace replay {

bool Player::Load(const std::string& path, std::string& err) {
    LoadResult res = ::replay::Load(path);
    if (!res.ok) {
        err = res.error;
        return false;
    }
    header    = std::move(res.header);
    records   = std::move(res.records);
    truncated = res.truncated;
    cursor    = 0;
    fed       = 0;
    late      = 0;

    // A clean file states where the recording ended. A truncated one does not,
    // so the last complete record is the furthest point the segment is known to
    // be consistent to (§6 E1) — the caller stops there.
    endFrame = res.trailer.endFrame;
    if (endFrame < 0 || truncated)
        endFrame = records.empty() ? 0 : records.back().frame;

    // The funnel appends in seq order, so file order is already the total
    // order. Sorting anyway costs one pass over a loaded file and makes the
    // driver robust to a future writer that interleaves (task 3's packer may
    // merge segments) rather than trusting an invariant it cannot check.
    std::stable_sort(records.begin(), records.end(),
                     [](const syncedinput::Record& a, const syncedinput::Record& b) {
                         if (a.frame != b.frame) return a.frame < b.frame;
                         if (a.phase != b.phase) return a.phase < b.phase;
                         return a.seq < b.seq;
                     });

    loaded = true;
    return true;
}

std::vector<const syncedinput::Record*> Player::Due(int32_t frame,
                                                    syncedinput::TickPhase phase) {
    std::vector<const syncedinput::Record*> out;
    if (!loaded) return out;

    const auto phaseVal = static_cast<uint8_t>(phase);
    while (cursor < records.size()) {
        const syncedinput::Record& r = records[cursor];
        const bool due = (r.frame < frame) ||
                         (r.frame == frame &&
                          static_cast<uint8_t>(r.phase) <= phaseVal);
        if (!due) break;
        if (r.frame < frame) ++late;
        out.push_back(&r);
        ++cursor;
        ++fed;
    }
    return out;
}

void Player::SetHashTrack(std::vector<HashPoint> track) {
    hashTrack = std::move(track);
    std::sort(hashTrack.begin(), hashTrack.end(),
              [](const HashPoint& a, const HashPoint& b) { return a.frame < b.frame; });
}

bool Player::WantHashAt(int32_t frame) const {
    auto it = std::lower_bound(hashTrack.begin(), hashTrack.end(), frame,
                               [](const HashPoint& p, int32_t f) { return p.frame < f; });
    return it != hashTrack.end() && it->frame == frame;
}

bool Player::CheckHash(int32_t frame, uint64_t hash) {
    auto it = std::lower_bound(hashTrack.begin(), hashTrack.end(), frame,
                               [](const HashPoint& p, int32_t f) { return p.frame < f; });
    if (it == hashTrack.end() || it->frame != frame)
        return true;   // not a reference point; nothing to say

    ++verify.checked;
    if (it->hash == hash) {
        ++verify.matched;
        return true;
    }
    if (verify.firstDivergenceFrame < 0) {
        verify.firstDivergenceFrame = frame;
        verify.expected = it->hash;
        verify.actual   = hash;
    }
    return false;
}

void Player::FinishVerify(int32_t lastFrame) {
    verify.missing = 0;
    for (const auto& p : hashTrack)
        if (p.frame > lastFrame) ++verify.missing;
}

// ─────────────────────────── process-wide state ───────────────────────────
Player& Feed() {
    static Player instance;
    return instance;
}

namespace {
Mode g_mode = Mode::Off;
}

Mode CurrentMode() { return g_mode; }
void SetCurrentMode(Mode m) { g_mode = m; }

}  // namespace replay
