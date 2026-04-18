/**
 * Server clock synchronisation.
 *
 * Estimates the offset between client and server clocks using
 * ping/pong exchanges. Used for snapshot interpolation timing.
 */

export class ServerClock {
    private offset: number = 0;
    private samples: number[] = [];
    private readonly maxSamples = 10;

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

    /** Get the number of samples collected. */
    getSampleCount(): number {
        return this.samples.length;
    }
}
