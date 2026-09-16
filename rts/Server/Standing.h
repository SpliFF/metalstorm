// Standing — the per-account progression number and the tier derived from it.
//
// PLAN-beta-journey.md §0/§(b). Standing is ONE persisted integer
// (`users.standing`); tier is never stored, only derived on read. That
// asymmetry is the whole design: a tier table that is written anywhere has to
// be re-written everywhere the thresholds move, and the thresholds are
// expected to move during beta. Derived, a threshold change is a recompile.
//
// Pure header, no database and no sqlite include — the lobby route, the game
// server's AuthRequest custom option and the tests all call the same two
// functions, and none of them needs a schema to do it.
#pragma once

#include <cstddef>

namespace Standing {

/// Lower bound of each tier, ascending. Tier N spans
/// [kTierThresholds[N], kTierThresholds[N+1]) with the last one open-ended.
inline constexpr int kTierThresholds[] = {0, 20, 60, 150, 400};
inline constexpr int kTierCount = static_cast<int>(sizeof(kTierThresholds) / sizeof(kTierThresholds[0]));
inline constexpr int kMaxTier = kTierCount - 1;

/// Tier for a standing value, clamped at both ends. Negative standing is not
/// reachable through the accrual path but is clamped rather than rejected —
/// this is read on every roster build and must not have a failure mode.
inline constexpr int TierFor(int standing) {
    int tier = 0;
    for (int i = 1; i < kTierCount; ++i) {
        if (standing >= kTierThresholds[i]) tier = i;
    }
    return tier;
}

/// Player-facing tier name. Out-of-range input yields "Recruit" rather than
/// null, for the same reason TierFor clamps.
inline constexpr const char* TierName(int tier) {
    switch (tier) {
        case 1:  return "Regular";
        case 2:  return "Veteran";
        case 3:  return "Officer";
        case 4:  return "Commander";
        default: return "Recruit";
    }
}

/// Standing still to earn before the next tier; 0 at the top tier.
inline constexpr int ToNextTier(int standing) {
    const int tier = TierFor(standing);
    if (tier >= kMaxTier) return 0;
    return kTierThresholds[tier + 1] - standing;
}

}  // namespace Standing
