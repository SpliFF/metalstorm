import { describe, it, expect, vi, afterEach } from 'vitest';
import { frameControlMessage, ControlFrameDeframer, WebTransportAdapter } from './transport';

// The control-stream framing is the one contract the WebTransport client and
// the C++ WebTransportServer must agree on byte-for-byte (GW2 Control tier).
// These tests lock it: frame()/deframe() round-trip, including the
// split-and-coalesce behaviour a byte-oriented QUIC stream produces.

function collect(chunks: Uint8Array[]): Uint8Array[] {
    const deframer = new ControlFrameDeframer();
    const out: Uint8Array[] = [];
    for (const c of chunks) deframer.push(c, (m) => out.push(m));
    return out;
}

describe('control-stream framing', () => {
    it('round-trips a single message', () => {
        const msg = new Uint8Array([0x01, 0xaa, 0xbb, 0xcc]);
        const got = collect([frameControlMessage(msg)]);
        expect(got).toHaveLength(1);
        expect(Array.from(got[0])).toEqual(Array.from(msg));
    });

    it('drains multiple frames coalesced into one chunk', () => {
        const a = new Uint8Array([1, 2, 3]);
        const b = new Uint8Array([9]);
        const c = new Uint8Array([7, 7, 7, 7, 7]);
        const merged = new Uint8Array([
            ...frameControlMessage(a), ...frameControlMessage(b), ...frameControlMessage(c),
        ]);
        const got = collect([merged]);
        expect(got.map((m) => Array.from(m))).toEqual([
            Array.from(a), Array.from(b), Array.from(c),
        ]);
    });

    it('reassembles a frame split across chunk boundaries', () => {
        const msg = new Uint8Array(Array.from({ length: 300 }, (_, i) => i & 0xff));
        const framed = frameControlMessage(msg);
        // Split mid-header and mid-payload.
        const chunks = [framed.slice(0, 2), framed.slice(2, 50), framed.slice(50)];
        const got = collect(chunks);
        expect(got).toHaveLength(1);
        expect(Array.from(got[0])).toEqual(Array.from(msg));
    });

    it('handles an empty payload', () => {
        const got = collect([frameControlMessage(new Uint8Array(0))]);
        expect(got).toHaveLength(1);
        expect(got[0].length).toBe(0);
    });

    it('emits nothing until a full length-prefixed frame has arrived', () => {
        const framed = frameControlMessage(new Uint8Array([5, 6, 7, 8]));
        const deframer = new ControlFrameDeframer();
        const out: Uint8Array[] = [];
        deframer.push(framed.slice(0, 4), (m) => out.push(m)); // header only
        expect(out).toHaveLength(0);
        deframer.push(framed.slice(4), (m) => out.push(m)); // payload
        expect(out).toHaveLength(1);
    });

    it('writes the length little-endian', () => {
        const framed = frameControlMessage(new Uint8Array(513)); // 0x0201
        expect(framed[0]).toBe(0x01);
        expect(framed[1]).toBe(0x02);
        expect(framed[2]).toBe(0x00);
        expect(framed[3]).toBe(0x00);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PLAN-endtoend.md D36 — a throwing inbound handler must cost exactly one
// message, not the rest of the connection.
//
// The reader loops used to call `onMessage` inside the same try/catch that
// catches "the stream closed", so any throw from the application stack (a
// rules-param decode, a widget RecvLuaMsg dispatch into Lua, anything) broke
// the loop and left the lane **permanently and silently deaf**. Reproduced
// live 2026-08-05: one injected throw froze the client's Spring.GetGameFrame()
// at 1650 while the server ran on to 13710 — the war was won and the winner's
// client never received the terminal GameInfo, so it sat on a finished match
// that still looked live, with an empty console, until the page was reloaded.

/** Minimal WebTransport double: exposes the controllers so a test can push
 *  bytes at the adapter's control / datagram readers. */
class FakeWebTransport {
    static last: FakeWebTransport | null = null;
    ready = Promise.resolve();
    closed = new Promise<never>(() => { /* never settles — no close in these tests */ });
    control!: ReadableStreamDefaultController<Uint8Array>;
    datagramCtl!: ReadableStreamDefaultController<Uint8Array>;
    datagrams: { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> };
    incomingUnidirectionalStreams = new ReadableStream({ start() { /* idle */ } });

    constructor() {
        FakeWebTransport.last = this;
        this.datagrams = {
            writable: new WritableStream(),
            readable: new ReadableStream<Uint8Array>({ start: (c) => { this.datagramCtl = c; } }),
        };
    }
    createBidirectionalStream(): Promise<{ writable: WritableStream<Uint8Array>;
                                           readable: ReadableStream<Uint8Array> }> {
        return Promise.resolve({
            writable: new WritableStream<Uint8Array>(),
            readable: new ReadableStream<Uint8Array>({ start: (c) => { this.control = c; } }),
        });
    }
    close(): void { /* no-op */ }
}

/** Let the reader loops' pending microtasks/reads run. */
const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('inbound handler faults are isolated per message', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        delete (globalThis as Record<string, unknown>).WebTransport;
        FakeWebTransport.last = null;
    });

    async function connectWith(onMessage: (m: Uint8Array) => void): Promise<FakeWebTransport> {
        (globalThis as Record<string, unknown>).WebTransport = FakeWebTransport;
        const adapter = new WebTransportAdapter({ onMessage });
        await adapter.connect('https://localhost:9100/');
        await settle();
        const wt = FakeWebTransport.last;
        if (!wt) throw new Error('fake transport was not constructed');
        return wt;
    }

    it('keeps the control lane open after a handler throws', async () => {
        const seen: number[] = [];
        const err = vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
        const wt = await connectWith((m) => {
            seen.push(m[0]);
            if (m[0] === 0xff) throw new Error('handler blew up');
        });

        wt.control.enqueue(frameControlMessage(new Uint8Array([0xff, 1])));  // throws
        wt.control.enqueue(frameControlMessage(new Uint8Array([0x11, 2])));  // must still arrive
        wt.control.enqueue(frameControlMessage(new Uint8Array([0x12, 3])));  // …and this one
        await settle();

        // Pre-fix this read [0xff] — the loop died on the first message and the
        // connection never delivered another control frame (the terminal
        // GameInfo among them).
        expect(seen).toEqual([0xff, 0x11, 0x12]);
        expect(err).toHaveBeenCalled();   // and it says so, instead of failing mute
    });

    it('drains the rest of a coalesced chunk when one frame in it throws', async () => {
        const seen: number[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
        const wt = await connectWith((m) => {
            seen.push(m[0]);
            if (m[0] === 0xff) throw new Error('handler blew up');
        });

        // One TCP-ish chunk carrying three frames — the throw must not strand
        // the two behind it in the deframer's buffer.
        wt.control.enqueue(new Uint8Array([
            ...frameControlMessage(new Uint8Array([0x21])),
            ...frameControlMessage(new Uint8Array([0xff])),
            ...frameControlMessage(new Uint8Array([0x22])),
        ]));
        await settle();

        expect(seen).toEqual([0x21, 0xff, 0x22]);
    });

    it('keeps the datagram lane open after a handler throws', async () => {
        const seen: number[] = [];
        vi.spyOn(console, 'error').mockImplementation(() => { /* quiet */ });
        const wt = await connectWith((m) => {
            seen.push(m[0]);
            if (m[0] === 0xff) throw new Error('handler blew up');
        });

        wt.datagramCtl.enqueue(new Uint8Array([0xff, 9]));
        wt.datagramCtl.enqueue(new Uint8Array([0x31, 9]));
        await settle();

        expect(seen).toEqual([0xff, 0x31]);
    });
});
