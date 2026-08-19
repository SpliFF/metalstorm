#include "WarLog.h"

namespace warlog {

DrainResult Drain(int64_t head, int64_t watermark, int ringSize,
                  const SlotReader& read) {
    DrainResult out;
    out.watermark = watermark;
    out.elided = 0;
    if (ringSize <= 0 || !read) return out;

    // A head BEHIND the watermark is not "nothing new" by accident — it is a
    // war whose seq went backwards, which happens exactly once and legitimately:
    // a GM rollback restores an older snapshot, and the gadget's cursor comes
    // back with it. Re-draining from the restored head would duplicate every
    // event of the rolled-back stretch, so the watermark stays where it is and
    // the stream simply resumes when the war passes its old high water again.
    if (head <= watermark) return out;

    int64_t first = watermark + 1;
    if (head - watermark > ringSize) {
        // The ring lapped. `head - ringSize + 1` is the oldest event still in
        // the buffer; everything between the watermark and it is unrecoverable.
        const int64_t oldest = head - ringSize + 1;
        Event gap;
        gap.seq = first;
        gap.kind = kElidedKind;
        gap.frame = 0;
        gap.team = -1;
        out.elided = oldest - first;
        gap.detail = std::to_string(out.elided);
        out.events.push_back(std::move(gap));
        first = oldest;
    }

    for (int64_t seq = first; seq <= head; ++seq) {
        Event e;
        const int slot = static_cast<int>(seq % ringSize);
        if (!read(slot, e)) {
            out.elided++;
            continue;
        }
        if (e.seq != seq) {
            // Not the event we asked for — a half-written slot, or one the
            // emitter has already recycled since `head` was read.
            out.elided++;
            continue;
        }
        out.events.push_back(std::move(e));
    }

    // The watermark advances to the head even when slots were skipped: those
    // events are gone, and leaving the cursor behind would re-walk the same
    // dead slots on every heartbeat for the rest of the war.
    out.watermark = head;
    return out;
}

}  // namespace warlog
