import { describe, it, expect } from 'vitest';
import { md5Bytes, base64Bytes, md5Base64 } from './vfs-hash.js';

const hex = (b: Uint8Array) =>
    Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

describe('md5Bytes — RFC 1321 test vectors', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    it('hashes the empty string', () => {
        expect(hex(md5Bytes(enc('')))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    });
    it('hashes "a"', () => {
        expect(hex(md5Bytes(enc('a')))).toBe('0cc175b9c0f1b6a831c399e269772661');
    });
    it('hashes "abc"', () => {
        expect(hex(md5Bytes(enc('abc')))).toBe('900150983cd24fb0d6963f7d28e17f72');
    });
    it('hashes "message digest"', () => {
        expect(hex(md5Bytes(enc('message digest')))).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    });
    it('hashes the 62-char alphanumeric vector (crosses a 64-byte block)', () => {
        const s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        expect(hex(md5Bytes(enc(s)))).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
    });
    it('hashes an 80-char input (two full blocks + padding block)', () => {
        const s = '1234567890'.repeat(8);
        expect(hex(md5Bytes(enc(s)))).toBe('57edf4a22be3c955ac49da2e2107b67a');
    });
});

describe('base64Bytes', () => {
    it('matches known base64 of MD5("abc") — VFS.CalculateHash type 0 shape', () => {
        // 900150983cd24fb0d6963f7d28e17f72 → base64
        expect(base64Bytes(md5Bytes(new TextEncoder().encode('abc'))))
            .toBe('kAFQmDzST7DWlj99KOF/cg==');
    });
    it('pads correctly for 1- and 2-byte tails', () => {
        expect(base64Bytes(new Uint8Array([0x4d]))).toBe('TQ==');
        expect(base64Bytes(new Uint8Array([0x4d, 0x61]))).toBe('TWE=');
        expect(base64Bytes(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    });
});

describe('md5Base64 (VFS.CalculateHash(input, 0))', () => {
    it('is deterministic and base64-shaped', () => {
        expect(md5Base64('abc')).toBe('kAFQmDzST7DWlj99KOF/cg==');
        expect(md5Base64('abc')).toBe(md5Base64('abc'));
        expect(md5Base64('abc')).not.toBe(md5Base64('abd'));
    });
});
