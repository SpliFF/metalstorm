#include "Server/Hibernation.h"

namespace hibernate {

const char* Describe(ExitReason r) {
    switch (r) {
        case ExitReason::Signal:      return "signal";
        case ExitReason::Idle:        return "idle";
        case ExitReason::PostGame:    return "post-game";
        case ExitReason::Restart:     return "restart";
        case ExitReason::HeadlessRun: return "headless-run";
        case ExitReason::Harness:     return "harness";
    }
    return "unknown";
}

CheckpointDecision DecideExitCheckpoint(const ExitContext& c) {
    CheckpointDecision d;

    if (c.replaying || c.reason == ExitReason::Harness) {
        d.reason = "this process re-executed a recording or ran a harness, "
                   "not a game — there is no world anybody is waiting to "
                   "rejoin";
        return d;
    }
    if (!c.hibernationEnabled) {
        d.reason = "hibernation is switched off for this process";
        return d;
    }
    if (!c.gameStarted) {
        d.reason = "GameStart never fired — there is no world to resume";
        return d;
    }
    if (c.gameOverDeclared || c.reason == ExitReason::PostGame) {
        d.reason = "the match is over — a finished war has nothing to resume";
        return d;
    }
    if (c.reason == ExitReason::HeadlessRun) {
        d.reason = "a headless run reached its own stop condition; its world "
                   "is a fixture, not a war";
        return d;
    }
    if (c.reason == ExitReason::Restart) {
        // A SIGHUP re-exec rebuilds the sim from argv, so the world IS lost
        // here — but deliberately, and by an operator who asked for exactly
        // that. It is not lossy in the sense the flag means (machinery that
        // could not do its job); making the re-exec itself resume is 3b's
        // respawn path applied to a second caller, not this decision.
        d.reason = "a restart re-execs this room from its command line; "
                   "resuming the re-exec is the lobby respawn path (task 3b)";
        return d;
    }
    if (!c.serializerAttached) {
        d.reason = "the sim serializer never attached, so no checkpoint could "
                   "be taken — this room's world is being LOST, not saved "
                   "(the attach gate logged which section or gadget refused)";
        d.lossy = true;
        return d;
    }

    d.checkpoint = true;
    d.label = std::string("hibernate:") + Describe(c.reason);
    d.reason = "checkpointing the world so the room can be resumed";
    return d;
}

IdleHibernateDecision DecideIdleHibernate(const IdleHibernateContext& c) {
    IdleHibernateDecision d;
    if (!c.persistentRoom) {
        d.reason = "not a persistent war — the idle-exit path applies instead";
        return d;
    }
    if (!c.hibernationEnabled || c.idleSeconds <= 0) {
        d.reason = "the hibernation window is switched off for this process";
        return d;
    }
    if (c.headlessRun || c.replaying) {
        d.reason = "a harness or replay run owns its own exit";
        return d;
    }
    if (c.sinceStartSec <= c.startupGraceSec) {
        d.reason = "still inside the startup grace";
        return d;
    }
    if (c.idleForSec <= c.idleSeconds) {
        d.reason = "a client has been connected within the idle window";
        return d;
    }
    // Eligible on every count except the war's own state. See the header: the
    // settlement is 300 frames of synced Lua that only this process can run,
    // and the room is empty exactly because the war was won.
    if (!c.warSimState.empty() && c.warSimState != "active") {
        d.reason = "the war has declared its ending (war_state=" + c.warSimState +
                   ") and is settling — hibernating now would truncate the "
                   "wind-down and lose the settlement";
        d.deferredForWarEnding = true;
        return d;
    }
    d.hibernate = true;
    d.reason = "no connected clients for the idle window";
    return d;
}

ResumeOutcome DoResume(IResumeSource& src, uint32_t roomId, const ResumeRequest& req) {
    ResumeOutcome o;
    if (!req.requested) {
        o.status = ResumeStatus::NotRequested;
        return o;
    }
    o.fatal = true;  // cleared only on Ok

    if (!req.startsGameAtSetup) {
        o.status = ResumeStatus::WrongShape;
        o.error = "--resume needs a session shape that fires GameStart during "
                  "set-up (a persistent war, or dev mode); this one waits for "
                  "a player roster, so there is no staged world to apply a "
                  "snapshot over";
        return o;
    }
    if (!src.Available()) {
        o.status = ResumeStatus::NoSerializer;
        o.error = "no sim serializer is attached, so nothing can be applied — "
                  "refusing to come up as a FRESH world for a room the lobby "
                  "believes is hibernated";
        return o;
    }
    const int32_t newest = src.NewestFrame(roomId);
    if (newest < 0) {
        o.status = ResumeStatus::NoSnapshot;
        o.error = "this room has no snapshot history at all — there is "
                  "nothing to resume, and starting fresh would silently "
                  "replace the war the players are rejoining";
        return o;
    }

    std::string err;
    int32_t restored = -1;
    if (!src.RestoreNewestValid(roomId, err, restored)) {
        o.status = ResumeStatus::RestoreFailed;
        o.error = err.empty() ? "every retained snapshot was rejected" : err;
        return o;
    }

    o.status = ResumeStatus::Ok;
    o.frame = restored;
    o.fatal = false;
    return o;
}

std::string FormatResume(const ResumeOutcome& o) {
    switch (o.status) {
        case ResumeStatus::Ok:
            return "resumed at frame " + std::to_string(o.frame);
        case ResumeStatus::NotRequested:
            return "no --resume requested; starting a new world";
        case ResumeStatus::WrongShape:
        case ResumeStatus::NoSerializer:
        case ResumeStatus::NoSnapshot:
        case ResumeStatus::RestoreFailed:
            return "resume REFUSED: " + o.error;
    }
    return "resume: unknown status";
}

}  // namespace hibernate
