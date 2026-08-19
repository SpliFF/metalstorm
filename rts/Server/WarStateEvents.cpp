#include "WarStateEvents.h"

namespace warevents {

using warresume::WarState;

namespace {

/// A process is up: the war is serving, or about to be. The two states a player
/// can act on right now.
bool Up(WarState s) {
    return s == WarState::Live || s == WarState::Resuming;
}

/// Frames are gone (or unreachable by this binary). The two states that cannot
/// be described with the word "hibernated".
bool Lossy(WarState s) {
    return s == WarState::Crashed || s == WarState::Unresumable;
}

}  // namespace

const char* ToString(Kind k) {
    switch (k) {
        case Kind::None:       return "none";
        case Kind::Resuming:   return "resuming";
        case Kind::Back:       return "back";
        case Kind::Hibernated: return "hibernated";
        case Kind::Lost:       return "lost";
    }
    return "none";
}

std::string Headline(Kind k) {
    switch (k) {
        case Kind::None:
            return "";
        case Kind::Resuming:
            return "Your war is coming back — restoring its world now.";
        case Kind::Back:
            return "Your war is running again.";
        case Kind::Hibernated:
            return "Your war went to sleep. Its world is saved; joining brings "
                   "it back.";
        case Kind::Lost:
            return "Your war stopped without saving its last stretch — some of "
                   "it is gone.";
    }
    return "";
}

Kind Detect(WarState prev, WarState next) {
    // A room that is not a war has no transitions to report, in either
    // direction. This also covers the sessionKind of a room that was never a
    // war being fed in by a caller that does not filter.
    if (next == WarState::NotAWar || prev == WarState::NotAWar) return Kind::None;
    if (prev == next) return Kind::None;

    switch (next) {
        // Arrived running. Anything that was not `Live` becoming `Live` is the
        // notification, INCLUDING straight from `Hibernated` — the 5 s
        // broadcast cadence samples a resume's middle state only sometimes, and
        // the fast resumes are exactly the ones a path-based detector would go
        // quiet on (header rule 2).
        case WarState::Live:
            return Kind::Back;

        // A process is up and not serving. From a stopped war this is the
        // resume starting. From `Live` it is a war that stopped serving with
        // its process still alive — a reload — and the sentence is the same
        // one, because what the player needs to know is identical: it is not
        // playable this second and it is on its way back.
        case WarState::Resuming:
            return Kind::Resuming;

        // Went to sleep cleanly. Only from a running war: a war that was
        // already stopped gaining a checkpoint row is bookkeeping, not news.
        case WarState::Hibernated:
            return Up(prev) ? Kind::Hibernated : Kind::None;

        // Frames lost. From a running war that is a crash; from a STOPPED war
        // it is task 3c's other case — a deploy moved the engine past the war's
        // own snapshots, so a world that was promised back this morning is not
        // coming back. Both are the same sentence and both must be said.
        // Between the two lossy states there is nothing new to say.
        case WarState::Crashed:
        case WarState::Unresumable:
            return Lossy(prev) ? Kind::None : Kind::Lost;

        // A war whose history went away (pruned, or a store that lost its
        // rows) reads as `Fresh`. Nothing happened *to the player* that a toast
        // helps with, and the card already says the war has not started.
        case WarState::Fresh:
            return Kind::None;

        // The war ENDED. Nothing to interrupt anybody with: §7's archive
        // already emitted the war-over digest, which is the surface that tells
        // a player how their war finished and who won — a toast here would be a
        // second, poorer announcement of the same thing, and one that arrives
        // whenever the server's post-game timer happens to fire rather than
        // when the war ended. What matters is that this is NOT `Lost`: before
        // D4 a finished war arrived at `Crashed` and every enlisted player was
        // told their war "stopped without saving its last stretch".
        case WarState::Finished:
            return Kind::None;

        case WarState::NotAWar:
            return Kind::None;
    }
    return Kind::None;
}

Kind Watcher::Observe(uint32_t roomId, WarState now) {
    auto it = last_.find(roomId);
    if (it == last_.end()) {
        // First sight seeds and never fires (header rule 1). A lobby restart
        // re-observes every war exactly once, and a burst of toasts about wars
        // that did not move is worse than no toast at all.
        last_.emplace(roomId, now);
        return Kind::None;
    }
    const WarState prev = it->second;
    it->second = now;
    return Detect(prev, now);
}

void Watcher::Forget(uint32_t roomId) { last_.erase(roomId); }

void Watcher::Retain(const std::set<uint32_t>& live) {
    for (auto it = last_.begin(); it != last_.end();)
        it = live.count(it->first) ? std::next(it) : last_.erase(it);
}

WarState Watcher::LastSeen(uint32_t roomId) const {
    auto it = last_.find(roomId);
    return it == last_.end() ? WarState::NotAWar : it->second;
}

}  // namespace warevents
