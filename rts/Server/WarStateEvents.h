// WarStateEvents — the moment a war changes state, as an event rather than a
// datum. PLAN-persistence task 4d.
//
// Tasks 3b/4a made a war's state *visible*: `warresume::Classify` says what the
// war IS and the room JSON publishes it, so a card can say "Hibernated" and
// mean it. What that shape cannot do is tell anybody that something HAPPENED.
// The state rides the `rooms` broadcast, so a war that comes back flips its
// badge on the next list tick — up to 5 s later, silently, on a card the player
// may not be looking at. A player who left a war a week ago and is waiting for
// it to come back is not watching a badge; they need to be told.
//
// So this file owns exactly one thing: the TRANSITION. It holds the last state
// each war was observed in, and answers "is this new state worth telling a
// player about, and which sentence is it". Pure — no sqlite, no room registry,
// no socket. The lobby's broadcast feeds it the states it has already computed
// and sends whatever it hands back.
//
// Three rules are load-bearing and each one is a defect this file exists to
// avoid:
//
//  1. **First sight SEEDS, it never fires.** A lobby restart re-observes every
//     war for the first time; if that counted as a transition, every connected
//     browser would get a burst of toasts about wars that did not move. The
//     same rule covers a war created while the lobby is up.
//  2. **The destination decides, not the path.** The broadcast cadence is 5 s
//     and a resume takes about that long, so `hibernated → resuming → live` is
//     routinely observed as `hibernated → live` with the middle state never
//     sampled. A detector written as a state machine over adjacent pairs would
//     drop the one notification that matters most on exactly the fast resumes.
//     `Detect` therefore classifies by where the war ARRIVED, qualified by
//     whether where it came from was up or down.
//  3. **Room ids are reused.** `Forget` exists so a war's transition history
//     cannot be inherited by the next war on that number, and `Retain` keeps
//     the map from being one more unbounded container in a process that stays
//     up for weeks (the `knownRoomAlarms` precedent in lobby_main.cpp).
//
// Who gets told is NOT decided here. The room-list SSE channel is a broadcast —
// there is no per-account stream — so the event names the room and the browser
// decides whether that war is one of *its* wars (it already knows: `enlisted`
// rides every row). Filtering server-side would need a per-connection identity
// the SSE layer does not have, and would put the "is this mine" answer in two
// places.

#pragma once

#include <cstdint>
#include <set>
#include <string>
#include <unordered_map>

#include "WarResume.h"

namespace warevents {

/// What happened to a war, in the player's terms. This is a wire vocabulary
/// (`ToString` is what the browser matches on) and it is deliberately coarser
/// than `WarState`: seven states collapse to four things worth interrupting
/// somebody for, plus "nothing".
enum class Kind : uint8_t {
    /// Not worth telling anyone: no movement, first sight, or a transition
    /// between two states that say the same thing to a player.
    None = 0,
    /// The war is coming back — a process is up but not serving yet. The
    /// player's own join may be what caused this, and it is still worth
    /// saying: E5's second joiner needs to know the wait is a resume.
    Resuming,
    /// The war is running again. Arrived at `Live` from anything that was not
    /// live, whether or not `Resuming` was ever observed (rule 2).
    Back,
    /// The war went to sleep with its world checkpointed. Nothing was lost;
    /// the next join brings it back.
    Hibernated,
    /// The war's process left without a checkpoint, or its stored world can no
    /// longer be loaded by this binary. Frames are gone. Distinguished from
    /// `Hibernated` because that difference is the whole of tasks 3b/3c.
    Lost,
};

/// The wire word. Matched by the browser, so it is spelled in the same
/// snake_case as `warresume::ToString`.
const char* ToString(Kind k);

/// The one sentence the event carries. Lives beside the vocabulary rather than
/// in the client so the lobby's log line and the player's toast cannot drift,
/// and so a new `Kind` cannot be added without prose for it.
///
/// Frame-free on purpose. "2h 06m of war" is a formatting of a frame into sim
/// time that the client already owns (`formatFrozenFrame`, task 4a), and a
/// second spelling of it here would be a second answer to the same question.
/// The toast quotes the frame off the war row it already holds.
std::string Headline(Kind k);

/// Pure. `prev` is the last state this war was OBSERVED in, `next` the state it
/// is in now. See rule 2 in the header: the classification is by destination.
Kind Detect(warresume::WarState prev, warresume::WarState next);

/// Per-room memory of the last observed state. Not thread-safe; the lobby drives
/// it from its broadcast, which is single-threaded.
class Watcher {
public:
    /// Record `now` for `roomId` and return what to tell players about it.
    /// Returns `Kind::None` on first sight (rule 1).
    Kind Observe(uint32_t roomId, warresume::WarState now);

    /// Drop a room's history. Called when a room goes away, because ids are
    /// reused (rule 3).
    void Forget(uint32_t roomId);

    /// Drop every room not in `live`. The bulk form of `Forget`, for callers
    /// that see the whole room list each pass and never see a removal.
    void Retain(const std::set<uint32_t>& live);

    /// How many rooms are remembered. For the growth assertion.
    size_t Size() const { return last_.size(); }

    /// The last state observed for `roomId`, or `NotAWar` if unseen. Test seam.
    warresume::WarState LastSeen(uint32_t roomId) const;

private:
    std::unordered_map<uint32_t, warresume::WarState> last_;
};

}  // namespace warevents
