#include "WarLifecycleSweep.h"

#include <sqlite3.h>

#include "GameEventsDb.h"
#include "WarOutcome.h"

std::string WarOverDigestDetail(const WarLifecycleStep& step,
                                const std::string& winnerFactions) {
    std::string s = WarTerminalReasonHeadline(step.reason);
    if (!winnerFactions.empty())
        s += " Victor: " + winnerFactions + ".";
    else if (!step.eliminatedFaction.empty())
        s += " Driven out: " + step.eliminatedFaction + ".";
    return s;
}

std::optional<WarLifecycleStep> AdvanceWarLifecycle(
    sqlite3* db, uint32_t roomId, const WarTerminationFacts& facts,
    bool hasLiveHumans, int64_t now) {
    if (!db)
        return std::nullopt;
    const auto war = WarDirector::Load(db, roomId);
    if (!war)
        return std::nullopt;

    WarLifecycleStep step;
    step.from = war->state;
    step.reason = EvaluateWarTermination(facts);
    if (step.reason == WarTerminalReason::FactionElimination)
        step.eliminatedFaction = EliminatedFaction(facts);
    step.to = NextWarState(war->state, step.reason, hasLiveHumans);
    if (step.to == step.from)
        return std::nullopt;

    if (!WarDirector::SetState(db, roomId, step.to, now))
        return std::nullopt;

    step.archived = step.to == WarState::Archived;
    if (!step.archived)
        return step;

    // ── The archive (§7 `archived`) ────────────────────────────────────────
    //
    // The reason is stamped BEFORE the digest is written, and the digest is
    // emitted only if the stamp is the one that landed. `SetTerminalReason`
    // is first-writer-wins, so this is what makes "enlisted players get a
    // war-over digest" fire exactly once for a war however many times the
    // sweep re-observes an archived row — including across a lobby restart,
    // where an in-memory latch would have been lost and every enlisted player
    // would be told a second time that a war they left last week had ended.
    const bool stamped =
        WarDirector::SetTerminalReason(db, roomId,
                                       WarTerminalReasonToString(step.reason));
    if (!stamped)
        return step;

    // The sim's half of the ending, when there is one. A war retired by an
    // operator, ended by a season boundary or decided by the foothold census
    // has no `war_outcome` row at all — that is not a gap, there was no in-sim
    // ending to record — and the digest simply carries no victor.
    std::string winners;
    // The frame the digest is stamped with. `wars.last_active_frame` is the
    // fallback and NOT the first choice: it is a heartbeat column, so it is
    // behind by up to a sweep even when it is maintained, and for a war ended
    // by the sim there is an exact answer — the frame `resolve()` stamped.
    // Every war-over digest carried `frame=0` before this (D3), including one
    // whose war demonstrably ended at frame 9300.
    int32_t digestFrame = static_cast<int32_t>(war->lastActiveFrame);
    if (const auto outcome = WarOutcomeDb::Load(db, roomId)) {
        winners = outcome->winnerFactions;
        if (outcome->finalFrame > 0)
            digestFrame = outcome->finalFrame;
    }

    // Seq continues the war's own stream rather than starting a new one: the
    // digest is served as "everything after my cursor", so a line numbered
    // below the reader's watermark would be invisible to exactly the players
    // who were there most recently. `Append` is INSERT OR IGNORE on
    // (room_id, seq), so a collision with a straggling sim event drops this
    // line rather than corrupting the stream — and the sim has declared game
    // over by now, so it has none left to write.
    warlog::Event e;
    e.seq = GameEventsDb::HighestSeq(db, roomId) + 1;
    e.kind = "war";
    e.subject = war->name.empty() ? std::string("The war") : war->name;
    e.detail = WarOverDigestDetail(step, winners);
    e.team = -1;
    e.frame = digestFrame;
    GameEventsDb::Append(db, roomId, {e}, now);

    return step;
}
