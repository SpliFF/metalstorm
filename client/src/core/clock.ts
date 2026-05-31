/**
 * Server clock synchronisation.
 *
 * Estimates the offset between client and server clocks using
 * ping/pong exchanges. Used for snapshot interpolation timing and the
 * presentation cursor (PLAN-latency.md L0 — `ServerClock.now()` feeds
 * `PresentationClock`).
 */

export class ServerClock {
    private offset: number = 0;
    private samples: number[] = [];
    private readonly maxSamples = 10;

    /** Smoothed round-trip time in ms (EMA over ping/pong samples). The
     *  presentation clock uses RTT/2 as the one-way-latency estimate to
     *  bias the cursor toward the true server leading edge. 0 until the
     *  first pong arrives. */
    private rttMs: number = 0;
    private rttSamples: number = 0;

    /** Record a ping/pong round-trip measurement. */
    addSample(clientSendTime: number, serverTime: number, clientReceiveTime: number): void {
        const rtt = clientReceiveTime - clientSendTime;
        const estimatedOffset = serverTime - (clientSendTime + rtt / 2);
        this.samples.push(estimatedOffset);
        if (this.samples.length > this.maxSamples) {
            this.samples.shift();
        }
        // Median of samples for stability
        const sorted = [...this.samples].sort((a, b) => a - b);
        this.offset = sorted[Math.floor(sorted.length / 2)];

        // RTT: exponential moving average. First sample seeds it directly
        // so the cursor's one-way estimate is usable immediately.
        if (rtt >= 0 && Number.isFinite(rtt)) {
            this.rttMs = this.rttSamples === 0 ? rtt : this.rttMs * 0.7 + rtt * 0.3;
            this.rttSamples++;
        }
    }

    /** Convert local time to estimated server time. */
    toServerTime(localTime: number): number {
        return localTime + this.offset;
    }

    /** Get current estimated server time. */
    now(): number {
        return performance.now() + this.offset;
    }

    /** Get the estimated clock offset in ms. */
    getOffset(): number {
        return this.offset;
    }

    /** Smoothed round-trip time in ms (0 before the first pong). */
    getRtt(): number {
        return this.rttMs;
    }

    /** One-way latency estimate in ms (RTT/2). */
    getOneWayLatency(): number {
        return this.rttMs * 0.5;
    }

    /** Get the number of samples collected. */
    getSampleCount(): number {
        return this.samples.length;
    }
}
