// VFS.CalculateHash backing — a self-contained, synchronous MD5 so the
// LuaUI worker can answer ZK/BAR widgets that hash strings.
//
// Recoil's `VFS.CalculateHash(input, hashType)` (rts/Lua/LuaVFS.cpp):
//   - hashType 0 (MD5)    → base64 of the 16-byte digest
//   - hashType 1 (SHA512) → hex of the 64-byte digest
// Every reaching consumer in BAR/ZK uses **type 0** for *local* dedup —
// `barwidgets.lua` widget-hash table, `gui_changelog_info.lua` "is the
// changelog new since I last saw it?", `ana_report_widgets.lua` content
// id ("no security needed here"). None compares the hash against a value
// computed by a C++ peer, so what matters is a *stable, deterministic*
// digest, not byte-identical agreement with the engine.
//
// DEVIATION (documented): the input is the worker's view of the Lua
// string, UTF-8-encoded here, whereas Recoil hashes the raw byte string.
// For the ASCII/UTF-8 text these consumers hash the two agree; they would
// only differ for non-UTF-8 binary input, which no type-0 consumer feeds.
// SubtleCrypto has no MD5 (and is async), so a small sync impl is the
// faithful choice for a synchronous Lua call.

/** Synchronous MD5. Returns the 16-byte digest. */
export function md5Bytes(bytes: Uint8Array): Uint8Array {
    // Per-round shift amounts.
    const S = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    // Precomputed table K[i] = floor(2^32 * abs(sin(i+1))).
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
        K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }

    const origLen = bytes.length;
    // Padding: 0x80, then zeros to 56 mod 64, then 64-bit little-endian bit length.
    const bitLen = origLen * 8;
    const padded = new Uint8Array((((origLen + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[origLen] = 0x80;
    // 64-bit length, little-endian. JS bit ops are 32-bit so split lo/hi.
    const lenLo = bitLen >>> 0;
    const lenHi = Math.floor(bitLen / 4294967296) >>> 0;
    const lenOff = padded.length - 8;
    padded[lenOff] = lenLo & 0xff;
    padded[lenOff + 1] = (lenLo >>> 8) & 0xff;
    padded[lenOff + 2] = (lenLo >>> 16) & 0xff;
    padded[lenOff + 3] = (lenLo >>> 24) & 0xff;
    padded[lenOff + 4] = lenHi & 0xff;
    padded[lenOff + 5] = (lenHi >>> 8) & 0xff;
    padded[lenOff + 6] = (lenHi >>> 16) & 0xff;
    padded[lenOff + 7] = (lenHi >>> 24) & 0xff;

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Uint32Array(16);
    const rotl = (x: number, c: number) => ((x << c) | (x >>> (32 - c))) >>> 0;

    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            M[i] = (padded[j] | (padded[j + 1] << 8) |
                (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
        }
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F: number, g: number;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
            else { F = C ^ (B | (~D >>> 0)); g = (7 * i) % 16; }
            F = (F + A + K[i] + M[g]) >>> 0;
            A = D; D = C; C = B;
            B = (B + rotl(F, S[i])) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0;
        c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }

    const out = new Uint8Array(16);
    const words = [a0, b0, c0, d0];
    for (let w = 0; w < 4; w++) {
        out[w * 4] = words[w] & 0xff;
        out[w * 4 + 1] = (words[w] >>> 8) & 0xff;
        out[w * 4 + 2] = (words[w] >>> 16) & 0xff;
        out[w * 4 + 3] = (words[w] >>> 24) & 0xff;
    }
    return out;
}

/** Standard base64 of a byte array (no line wrapping), matching Recoil's
 *  base64(MD5) output for `VFS.CalculateHash(input, 0)`. */
export function base64Bytes(bytes: Uint8Array): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += chars[b0 >> 2];
        out += chars[((b0 & 3) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
    }
    return out;
}

/** VFS.CalculateHash(input, 0) — base64(MD5(utf8(input))). */
export function md5Base64(input: string): string {
    return base64Bytes(md5Bytes(new TextEncoder().encode(input)));
}
