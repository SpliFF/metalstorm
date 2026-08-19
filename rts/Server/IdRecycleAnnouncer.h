/**
 * IdRecycleAnnouncer — PLAN-long-uptime S5 task 6.
 *
 * Decides, per entity-state tick, whether the outgoing snapshot carries
 * FLAG_ID_RECYCLED. Pure by construction so the window discipline is
 * decidable in a test: the engine-coupled half is StateStreamer's gather
 * (reading the epoch off the unit handler and OR-ing the flag into the field
 * mask), which is verified live.
 *
 * The discipline is the whole point. Announcing a recycle once would be
 * correct on a reliable channel; the entity lane is neither reliable nor
 * ordered — it is newest-wins, so a message can be superseded before it is
 * delivered. So the flag is raised on the epoch move and retired only on the
 * first FULL snapshot of a LATER tick, which makes it ride a whole snapshot
 * period (~10 messages) and makes losing the announcement mean losing all of
 * them.
 */
#pragma once

#include <cstdint>

namespace EntityState {

class IdRecycleAnnouncer {
public:
    /**
     * Feed one entity-state tick.
     *
     * @param epoch          SimObjectIDPool::GetRecycleEpoch(), via
     *                       CUnitHandler::IdRecycleEpoch().
     * @param isFullSnapshot whether this tick sends a full snapshot.
     * @return true if this tick's messages must carry FLAG_ID_RECYCLED.
     */
    bool Tick(uint32_t epoch, bool isFullSnapshot) {
        const bool raisedThisTick = (epoch != lastEpoch);
        if (raisedThisTick) {
            lastEpoch = epoch;
            pending = true;
        }

        const bool flagThisTick = pending;

        // Retire only on a full snapshot of a later tick — never on the tick
        // that raised it, or a recycle landing exactly on a snapshot frame
        // would be announced by one message and one message only.
        if (isFullSnapshot && !raisedThisTick)
            pending = false;

        return flagThisTick;
    }

    bool IsPending() const { return pending; }

private:
    uint32_t lastEpoch = 0;
    bool pending = false;
};

} // namespace EntityState
