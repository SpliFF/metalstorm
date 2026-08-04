/**
 * Artificial-latency simulator decision logic (PLAN-latency L0's validation
 * tool). Pure — no timers, no clock, no RNG of its own — so the ordering
 * invariant that matters can actually be tested. `Connection` owns the timers
 * and feeds this the current time and a random sample.
 *
 * **Two lanes, matching what the real transport guarantees.** The inbound link
 * is not one homogeneous pipe: entity state rides unreliable datagrams, while
 * control (FlatBuffers, including `Pong`), projectile, piece, build, LOS, decal
 * and heightmap envelopes ride reliable ordered QUIC streams. Simulating both
 * as datagrams would drop control messages that can never be lost in reality;
 * simulating neither — which is what the pre-2026-08-03 version did, delaying
 * *only* entity state — under-tests the link in two ways the L-pre and L1 gates
 * both recorded:
 *
 *   1. `Pong` bypassed the sim, so `ServerClock`'s RTT never saw the injected
 *      delay. `PresentationClock`'s `D` auto-adapts off that RTT, so `D` never
 *      grew to cover the injection and the jitter buffer ran nearly empty under
 *      `intercont` — the drill looked smooth for the wrong reason.
 *   2. The projectile lane arrived undelayed while units were delayed, so the
 *      L2/L3 projectile gates could not trust `netSim` to represent a laggy
 *      link at all.
 *
 * The reliable lane is therefore delayed by the same base + jitter but released
 * **in arrival order** — a late packet head-of-line-blocks the ones behind it,
 * exactly as an ordered stream does — and is **never dropped**.
 */

export interface NetSimConfig {
    enabled: boolean;
    delayMs: number;
    jitterMs: number;
    lossProb: number;
}

/** What to do with one inbound envelope. */
export type NetSimVerdict =
    /** Deliver right now, synchronously. */
    | { kind: 'pass' }
    /** Drop it on the floor (datagram lane only). */
    | { kind: 'drop' }
    /** Deliver after `delayMs`; `streamReleaseAt` is the caller's new ordered-lane cursor. */
    | { kind: 'delay'; delayMs: number; streamReleaseAt: number };

/**
 * Decide the fate of one envelope.
 *
 * @param cfg               current netsim settings
 * @param isStateLane       true for entity-state envelopes (the lossy, reorderable lane)
 * @param now               current monotonic time in ms
 * @param streamReleaseAt   ordered-lane cursor: the absolute time the previously
 *                          queued reliable envelope is due. Pass 0 initially.
 * @param rand              two independent uniform [0,1) samples: loss roll, jitter roll
 */
export function netSimDecide(
    cfg: NetSimConfig,
    isStateLane: boolean,
    now: number,
    streamReleaseAt: number,
    rand: () => number,
): NetSimVerdict {
    if (!cfg.enabled) return { kind: 'pass' };

    // Loss applies to the datagram lane only — a reliable stream retransmits.
    if (isStateLane && cfg.lossProb > 0 && rand() < cfg.lossProb) {
        return { kind: 'drop' };
    }

    const jitter = cfg.jitterMs > 0 ? (rand() * 2 - 1) * cfg.jitterMs : 0;
    let delayMs = Math.max(0, cfg.delayMs + jitter);

    if (isStateLane) {
        // Independent per-packet delay: jitter genuinely reorders, which is the
        // condition PresentationClock's reorder/loss tracking exists to detect.
        return delayMs <= 0
            ? { kind: 'pass' }
            : { kind: 'delay', delayMs, streamReleaseAt };
    }

    // Ordered lane: never release ahead of an envelope that arrived earlier.
    // When arrivals are spaced wider than the jitter range the previous cursor
    // is already in the past and this clamp does nothing; only bursts get
    // serialised, which is precisely head-of-line blocking.
    const releaseAt = Math.max(now + delayMs, streamReleaseAt);
    delayMs = releaseAt - now;
    // delayMs <= 0 implies releaseAt <= now, i.e. the cursor is already in the
    // past — leaving it unchanged is equivalent, so `pass` needs no new cursor.
    return delayMs <= 0
        ? { kind: 'pass' }
        : { kind: 'delay', delayMs, streamReleaseAt: releaseAt };
}
