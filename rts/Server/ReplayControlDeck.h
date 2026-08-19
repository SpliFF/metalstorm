// ReplayControlDeck — who may drive a replay, and what a drive request means
// (PLAN-replay.md task 4b, answering §7.13 T4a-1).
//
// WHY THIS IS A SEPARATE, PURE CLASS
// ----------------------------------
// Task 4a admitted live spectators to a replay server. It deliberately did not
// give them any way to change the playback, because every control PLAN-replay
// §2/§5 names ("speed = the server's existing speedFactor, pause = gs->paused,
// seek = load the nearest checkpoint", "ride the existing debug-console verbs")
// is a `ConsoleCommand` — classified `Synced`, the class a replay server
// refuses from live clients by construction. Widening that gate would have
// admitted arbitrary Lua against a re-executing sim.
//
// So the controls arrive as their own wire verb (`ReplayControl`, classified
// `Ignored`: never journaled, dropped on a live server) and the *policy* — who
// holds them, which requests are honourable, what a refusal says — lives here,
// with no engine globals, so tests/test_replay_control_deck.cpp can state it.
// server_main/ClientMessageHandler own the engine-coupled half: turning an
// Applied decision into `gs->paused`, `gs->wantedSpeedFactor` and
// `replay::Feed().SetSeekTarget()`.
//
// THE AUTHORITY QUESTION (§5 "casting = one replay server, many spectators")
// -------------------------------------------------------------------------
// T4a-1 asked who gets to pause a cast. The answer here: **the first spectator
// to attach holds the controls, and control passes to the next attached
// spectator when the holder leaves.** Reasons, since a plausible alternative is
// "everyone drives":
//
//   * A replay is a shared timeline. Two spectators seeking in opposite
//     directions is not a merge conflict the server can resolve — a seek is a
//     destructive, one-way fast-forward (see below), so the loser of a race
//     watches minutes of game they did not ask for.
//   * It needs no new concept. There is no lobby-side notion of a cast host to
//     hang this off (T4a-2: the lobby cannot even list replay files yet), and
//     inventing one here would be building 4c's furniture from the wrong end.
//   * It degrades safely: a lone watcher — which is every case today — is
//     always the controller, so the rule is invisible until casting exists.
//
// POV is explicitly NOT controller-gated. Which team's fog you watch is a
// personal view choice, it is per-client state already (`ClientSession::
// spectatorVisibilityMode/Team`, read by StateStreamer at five sites), and one
// watcher changing it cannot affect another's stream.
//
// WHY A BACKWARD SEEK IS REFUSED RATHER THAN SERVED
// -------------------------------------------------
// FIDELITY-STANDIN: PLAN-replay §2 specifies seek as "load nearest checkpoint
// <= target, fast-forward, resume" and notes "backward seek = same (checkpoints
// make it cheap)". Checkpoints do not exist yet: nothing writes a checkpoint
// blob until PLAN-persistence's `ISimSerializer` lands, so every replay file
// written so far carries an empty checkpoint index (ReplayPlayer.h says so at
// the accessor). Without one there is no way back — `Player`'s record cursor is
// monotonic by design, and the sim cannot be un-run. A backward seek is
// therefore refused with a reason naming the missing capability, rather than
// silently clamped to "no-op" or faked by restarting the process under the
// watcher. Forward seek works today and is frame-exact; it is only slower than
// it will be when checkpoints make it a jump.
#pragma once

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace replay {

/// What a spectator asked the playback to do. Mirrors the wire enum
/// (`SpringWeb::ReplayControlAction`) without depending on generated headers,
/// so this stays testable in isolation.
enum class ControlAction {
    Pause = 0,
    Resume = 1,
    SetSpeed = 2,
    Seek = 3,
    SetPovTeam = 4,
};

struct ControlRequest {
    ControlAction action = ControlAction::Pause;
    float   speed   = 1.0f;
    int32_t frame   = 0;
    int32_t povTeam = -1;
};

/// Outcome of a request. `Refused` always carries a reason: a control that
/// does nothing and says nothing reads as a broken build, and the two cases a
/// spectator will actually hit (someone else is driving; you cannot rewind)
/// are both things a person needs told.
struct ControlDecision {
    bool accepted = false;
    std::string reason;          ///< empty iff accepted
    /// Set when accepted — the caller applies exactly these.
    bool  setPaused   = false;   ///< apply `paused`
    bool  setSpeed    = false;   ///< apply `speed`
    bool  setSeek     = false;   ///< apply `seekTarget`
    bool  setPov      = false;   ///< apply `povTeam` to THIS client only
    bool    paused    = false;
    float   speed     = 1.0f;
    int32_t seekTarget = 0;
    int32_t povTeam   = -1;
};

/// Playback speed bounds. The lower bound matches the sim loop's own clamp
/// (server_main's computeTickInterval, 0.05x) so a control cannot ask for a
/// pace the loop will silently ignore; the upper bound is deliberately lower
/// than that clamp's 100x — past ~8x a watched replay is not being watched,
/// and an uncapped "speed" is a seek wearing a different hat.
inline constexpr float kMinSpeed = 0.25f;
inline constexpr float kMaxSpeed = 8.0f;

class ControlDeck {
public:
    // ── attachment / authority ──────────────────────────────────────────
    /// A spectator attached. The first one becomes the controller.
    /// Idempotent: re-attaching the current controller does not hand the
    /// controls away.
    void Attach(int playerNum) {
        if (std::find(watchers.begin(), watchers.end(), playerNum) == watchers.end())
            watchers.push_back(playerNum);
        if (controller < 0) controller = playerNum;
    }

    /// A spectator left. If it was the controller, the longest-attached
    /// remaining watcher takes over — not "nobody", because a cast whose host
    /// closes their tab should not freeze for everyone else.
    void Detach(int playerNum) {
        watchers.erase(std::remove(watchers.begin(), watchers.end(), playerNum),
                       watchers.end());
        if (controller == playerNum)
            controller = watchers.empty() ? -1 : watchers.front();
    }

    int Controller() const { return controller; }
    bool IsController(int playerNum) const {
        return playerNum >= 0 && playerNum == controller;
    }
    size_t WatcherCount() const { return watchers.size(); }

    // ── playback state ──────────────────────────────────────────────────
    bool Paused() const { return paused; }
    float Speed() const { return speed; }
    int32_t SeekTarget() const { return seekTarget; }
    bool Seeking() const { return seeking; }
    /// Called by the loop once the sim has reached the seek target.
    void SeekFinished() { seeking = false; }

    /// Decide a request. `curFrame` is the sim frame playback is at now and
    /// `endFrame` the recording's last; both bound a seek.
    ControlDecision Decide(int playerNum, const ControlRequest& req,
                           int32_t curFrame, int32_t endFrame) {
        ControlDecision d;

        // POV first: it is per-client and needs no authority, so it must not
        // be caught by the controller check below.
        if (req.action == ControlAction::SetPovTeam) {
            d.accepted = true;
            d.setPov   = true;
            // Anything negative means "global view" — the client sends -1 but
            // a stale UI could send another negative, and clamping is kinder
            // than refusing a request whose intent is unambiguous.
            d.povTeam  = req.povTeam < 0 ? -1 : req.povTeam;
            return d;
        }

        if (!IsController(playerNum)) {
            d.reason = controller < 0
                ? "replay controls are unavailable (no controller attached)"
                : "another spectator is driving this replay (player " +
                      std::to_string(controller) + ")";
            return d;
        }

        switch (req.action) {
            case ControlAction::Pause:
            case ControlAction::Resume: {
                const bool want = (req.action == ControlAction::Pause);
                paused = want;
                d.accepted = true;
                d.setPaused = true;
                d.paused = want;
                return d;
            }
            case ControlAction::SetSpeed: {
                // NaN survives every comparison, so test it rather than
                // relying on clamp: std::clamp(NaN, lo, hi) returns NaN and a
                // NaN tick interval busy-spins the sim loop.
                if (!(req.speed > 0.0f) || !(req.speed <= kMaxSpeed * 4.0f)) {
                    d.reason = "playback speed out of range";
                    return d;
                }
                speed = std::clamp(req.speed, kMinSpeed, kMaxSpeed);
                d.accepted = true;
                d.setSpeed = true;
                d.speed = speed;
                return d;
            }
            case ControlAction::Seek: {
                if (req.frame <= curFrame) {
                    // See the header comment: no checkpoints, no way back.
                    d.reason = "this replay cannot seek backwards yet — it "
                               "carries no checkpoints, so playback can only "
                               "run forwards from frame " +
                               std::to_string(curFrame);
                    return d;
                }
                if (req.frame > endFrame) {
                    d.reason = "seek past the end of the recording (last frame " +
                               std::to_string(endFrame) + ")";
                    return d;
                }
                seekTarget = req.frame;
                seeking = true;
                // A seek out of a paused replay must un-pause it, or the sim
                // never ticks and the fast-forward never happens — the watcher
                // would see the bar move and nothing else, which is the worst
                // kind of dead control.
                paused = false;
                d.accepted  = true;
                d.setSeek   = true;
                d.setPaused = true;
                d.paused    = false;
                d.seekTarget = req.frame;
                return d;
            }
            case ControlAction::SetPovTeam:
                break;  // handled above
        }
        d.reason = "unknown replay control";
        return d;
    }

private:
    /// Attach order. A vector, not a set: "longest-attached remaining watcher"
    /// is the succession rule and it needs the order preserved.
    std::vector<int> watchers;
    int controller = -1;
    bool paused = false;
    float speed = 1.0f;
    int32_t seekTarget = 0;
    bool seeking = false;
};

/// Process-wide deck, like Feed(). One server, one replay, one set of controls.
ControlDeck& Controls();

}  // namespace replay
