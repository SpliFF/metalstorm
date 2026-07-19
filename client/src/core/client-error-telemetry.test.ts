import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    configureErrorTelemetry, reportClientError, hashReportKey,
    resetErrorTelemetryForTests, type ClientErrorReport,
} from './client-error-telemetry.js';

function report(overrides: Partial<ClientErrorReport> = {}): ClientErrorReport {
    return {
        reason: 'fatal',
        errorClass: 'TypeError',
        message: 'boom',
        stack: 'TypeError: boom\n  at foo (x.js:1:1)',
        ...overrides,
    };
}

describe('client-error-telemetry', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        resetErrorTelemetryForTests();
        fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', fetchMock);
        configureErrorTelemetry({ endpoint: 'http://lobby.test', token: 'tok', enabled: true });
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('sends the first occurrence immediately with count=1', async () => {
        reportClientError(report());
        await vi.runAllTimersAsync();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://lobby.test/api/client-errors');
        expect(init.headers.Authorization).toBe('Bearer tok');
        const body = JSON.parse(init.body);
        expect(body.count).toBe(1);
        expect(body.error_class).toBe('TypeError');
        expect(body.stack_hash).toBe(hashReportKey('TypeError', 'boom', report().stack!));
    });

    it('dedups an immediate repeat of the same hash — no second send until the debounce window', async () => {
        reportClientError(report());
        await vi.runOnlyPendingTimersAsync();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        reportClientError(report());
        reportClientError(report());
        // Still within the debounce window — no second network call yet.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Advance past the recount debounce (60s) — exactly one follow-up
        // send, carrying the accumulated count, not one per occurrence.
        await vi.advanceTimersByTimeAsync(61_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const body = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(body.count).toBe(3);
    });

    it('a distinct error is not deduped against a different hash', async () => {
        reportClientError(report({ message: 'boom' }));
        reportClientError(report({ message: 'crash' }));
        await vi.runOnlyPendingTimersAsync();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rate-caps at 5 sends per hour per session', async () => {
        for (let i = 0; i < 8; i++) {
            reportClientError(report({ message: `err-${i}` }));
        }
        await vi.runOnlyPendingTimersAsync();
        expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('does not send when disabled (lobby opt-out)', async () => {
        configureErrorTelemetry({ enabled: false });
        reportClientError(report());
        await vi.runOnlyPendingTimersAsync();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('caps the payload at 32KB, dropping the log ring before truncating the stack', async () => {
        const hugeRing = Array.from({ length: 2000 }, (_, i) => `log line ${i} `.repeat(10));
        reportClientError(report({ logRing: hugeRing, stack: 'x'.repeat(50_000) }));
        await vi.runOnlyPendingTimersAsync();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const rawBody = fetchMock.mock.calls[0][1].body as string;
        expect(new TextEncoder().encode(rawBody).length).toBeLessThanOrEqual(32 * 1024);
        const body = JSON.parse(rawBody);
        expect(body.log_ring).toEqual([]);
    });

    it('retries once on a network failure, then gives up silently', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce({ ok: true, status: 200 });
        reportClientError(report());
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // Retry fires after the 5s delay.
        await vi.advanceTimersByTimeAsync(5100);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // A second failure is dropped, not retried again.
        fetchMock.mockRejectedValue(new Error('still down'));
        reportClientError(report({ message: 'another' }));
        await vi.advanceTimersByTimeAsync(6000);
        // one send attempt (fails) + one retry attempt = 2 more calls, no third.
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });
});
