#include "ReplayPlayer.h"

#include "ReplayCompatPolicy.h"
#include "ReplayControlDeck.h"

#include <algorithm>

namespace replay {

bool Player::Load(const std::string& path, std::string& err) {
    LoadResult res = ::replay::Load(path);
    if (!res.ok) {
        err = res.error;
        return false;
    }
    // The wire-schema gate, BEFORE anything is moved out of the result or fed
    // anywhere (PLAN-protocol-guard task 7). A record's payload is an undecoded
    // ClientMessage frame, so a schema the recording was not made against does
    // not fail to parse — it parses into different fields, and the divergence
    // surfaces frames later as an unexplained hash break. Refusing here is the
    // difference between one legible error and a confident wrong replay.
    const CompatVerdict compat = CheckSchemaHash(res.header.schemaHash);
    if (!compat.accepted) {
        err = compat.error;
        return false;
    }

    header      = std::move(res.header);
    records     = std::move(res.records);
    checkpoints = std::move(res.checkpoints);
    startCheckpoint = std::move(res.startCheckpoint);
    truncated   = res.truncated;
    cursor      = 0;
    fed         = 0;
    late        = 0;

    // The file's own hash track is the default reference series (task 3): a
    // recording verifies against itself with no second file. An explicit
    // `--verify <path>` calls SetHashTrack afterwards and wins.
    if (!res.hashTrack.empty()) SetHashTrack(std::move(res.hashTrack));

    // A clean file states where the recording ended. A truncated one does not,
    // so the furthest point the segment is known to be consistent to has to be
    // inferred from its blocks (§6 E1) — the caller stops there.
    //
    // Both series count, and that is not cosmetic. Records are sparse: a quiet
    // AI game can go a whole minute without one, while hash points land on a
    // fixed cadence. Inferring the end from records alone (which is what task 2
    // did, when records were the only blocks) makes a killed recording claim to
    // end at its last *input* — for a papertanks run whose only record is the
    // frame -1 GameStart anchor, that reads as "ends at frame -1", so the replay
    // stops before its first tick and every embedded hash point is reported
    // MISSING. Observed on a real `kill -9`'d recording, not hypothesised.
    endFrame = res.trailer.endFrame;
    if (endFrame < 0 || truncated) {
        endFrame = records.empty() ? 0 : records.back().frame;
        if (!hashTrack.empty())
            endFrame = std::max(endFrame, hashTrack.back().frame);
    }

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

    // T2-a: build the identity index up front. Scanned in the sorted stream
    // order, so a connection that authenticated more than once (a reconnect on
    // the same transport id) resolves to its LAST resolution — the one in force
    // for the rest of the recording.
    identities.clear();
    for (const syncedinput::Record& r : records) {
        if (r.kind != syncedinput::InputKind::AuthIdentity) continue;
        syncedinput::AuthIdentity id;
        if (!syncedinput::DecodeAuthIdentity(r.payload, id)) {
            // A malformed identity is not skippable: the connection it belongs
            // to would silently fall back to "never authenticated" and every
            // later command from it would be refused, producing a confident
            // replay of a game nobody played.
            err = "corrupt auth-identity record at seq " + std::to_string(r.seq);
            return false;
        }
        identities[RecordedClientId(r.clientId)] = std::move(id);
    }

    loaded = true;
    return true;
}

const syncedinput::AuthIdentity* Player::IdentityFor(uint32_t recordedClientId) const {
    auto it = identities.find(RecordedClientId(recordedClientId));
    return it == identities.end() ? nullptr : &it->second;
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
int  g_nextSpectatorPlayerNum = kSpectatorPlayerNumBase;
}

Mode CurrentMode() { return g_mode; }
void SetCurrentMode(Mode m) { g_mode = m; }

int AllocSpectatorPlayerNum() { return g_nextSpectatorPlayerNum++; }

ControlDeck& Controls() {
    static ControlDeck instance;
    return instance;
}

}  // namespace replay
