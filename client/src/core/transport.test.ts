import { describe, it, expect } from 'vitest';
import { frameControlMessage, ControlFrameDeframer } from './transport';

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
