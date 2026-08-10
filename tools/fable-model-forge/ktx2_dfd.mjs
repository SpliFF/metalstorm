// ktx2_dfd.mjs — put a sized `bytesPlane0` back into a supercompressed
// KTX2's basic data format descriptor.
//
// KTX2 <= 2.0.3 said a supercompressed file's `bytesPlane0..7` must read
// *unsized* (all zero), because the bytes on disk are not the bytes the
// DFD describes. Spec 2.0.4 reversed that — the DFD describes the
// *inflated* texel block, whose size a reader needs before it has
// inflated anything — so `bytesPlane0` must be non-zero. Encoders written
// against the old rule still zero it, and both of ours did: libktx 4.3.2
// in `textureconverter` (fixed in-place there, see
// rts/System/FileSystem/Ktx2BytesPlane.h) and the Basis Universal WASM
// build behind `babylonpress-ktx2-encoder`, which is what every
// `encode*.mjs` in this directory uses.
//
// `ktx validate` reports the defect as `warning-6030` and still exits 0,
// so nothing was blocked by it and nothing renders wrong: the 62
// `toktx v4.4.2`-written textures in `data/games/metalstorm/models/`
// already carry a sized `bytesPlane0` and load in the same client, from
// the same directory, as the ones that do not. See PLAN-maps.md M8f/M9i.
//
// Also runnable as a CLI to repair files already on disk — the fix moves
// exactly one byte per file and touches no pixel data:
//
//   node ktx2_dfd.mjs --check <file...>   report, change nothing
//   node ktx2_dfd.mjs --fix   <file...>   rewrite in place
import { readFileSync, writeFileSync } from 'fs';

const KTX2_ID = Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]);

// KTX2 header offsets (section 3.1). Everything is little-endian.
const OFF_SUPERCOMPRESSION = 44;
const OFF_DFD_BYTE_OFFSET = 48;

// Word indices inside the *basic* DFD block, from Khronos' khr_df.h. The
// block starts 4 bytes past dfdByteOffset — the first word there is the
// descriptor's total size, not part of any block.
const BDFD_WORD_BLOCKSIZE = 1;   // versionNumber | descriptorBlockSize
const BDFD_WORD_BYTESPLANE0 = 4;
const BDFD_SAMPLE_START = 6;
const BDFD_WORDS_PER_SAMPLE = 4;

/// Byte offset of the `bytesPlane3..0` word within `buf`, or null if this
/// is not a supercompressed KTX2 (in which case there is nothing to fix —
/// no encoder clears the field for an uncompressed file).
function bytesPlane0WordOffset(buf) {
  if (buf.length < 80 || !buf.subarray(0, 12).equals(KTX2_ID)) return null;
  if (buf.readUInt32LE(OFF_SUPERCOMPRESSION) === 0) return null;
  const dfd = buf.readUInt32LE(OFF_DFD_BYTE_OFFSET);
  if (!dfd || dfd + 24 > buf.length) return null;
  return dfd + 4 + BDFD_WORD_BYTESPLANE0 * 4;
}

/// The inflated size of one texel block, in bytes, read off the DFD's own
/// sample descriptions: the highest bit any sample occupies, rounded up.
///
/// Derived rather than looked up by colorModel so this stays right for
/// every format the tree writes without a table to keep in sync — UASTC
/// (one 128-bit sample) gives 16, ETC1S and BC1 (one 64-bit sample) give
/// 8, RGBA8 (four 8-bit samples) gives 4. Returns 0 for a DFD with no
/// samples, which the caller must treat as "cannot fix", never as "fixed".
export function texelBlockBytes(buf, dfdByteOffset) {
  const base = dfdByteOffset + 4;
  const blockSize = buf.readUInt32LE(base + BDFD_WORD_BLOCKSIZE * 4) >>> 16;
  const numSamples = Math.floor((blockSize - BDFD_SAMPLE_START * 4) / (BDFD_WORDS_PER_SAMPLE * 4));
  let topBit = 0;
  for (let s = 0; s < numSamples; s++) {
    const w = buf.readUInt32LE(base + (BDFD_SAMPLE_START + s * BDFD_WORDS_PER_SAMPLE) * 4);
    const bitOffset = w & 0xFFFF;
    const bitLength = ((w >>> 16) & 0xFF) + 1;   // stored as length-1
    topBit = Math.max(topBit, bitOffset + bitLength);
  }
  return Math.ceil(topBit / 8);
}

/// Size `bytesPlane0` in `buf` (a KTX2 file image) in place.
/// Returns {changed, bytes} — `changed` false when the file was already
/// conformant or is not supercompressed. Throws when the DFD claims a
/// texel block of zero bytes: that is a broken descriptor, and guessing a
/// size the file does not claim would be a silent stand-in.
export function sizeBytesPlane0(buf) {
  const at = bytesPlane0WordOffset(buf);
  if (at === null) return { changed: false, bytes: 0 };
  const current = buf.readUInt32LE(at) & 0xFF;
  if (current !== 0) return { changed: false, bytes: current };
  const bytes = texelBlockBytes(buf, buf.readUInt32LE(OFF_DFD_BYTE_OFFSET));
  if (bytes === 0 || bytes > 0xFF) {
    throw new Error(`cannot derive bytesPlane0: DFD reports a ${bytes}-byte texel block`);
  }
  buf.writeUInt32LE((buf.readUInt32LE(at) & 0xFFFFFF00) | bytes, at);
  return { changed: true, bytes };
}

/// Encoder-side entry point: hand it whatever `encodeToKTX2` returned,
/// get back bytes that pass `ktx validate` without warning-6030.
export function fixupEncoded(bytes) {
  const buf = Buffer.from(bytes);
  sizeBytesPlane0(buf);
  return buf;
}

// --- CLI ------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, ...files] = process.argv.slice(2);
  if ((mode !== '--check' && mode !== '--fix') || files.length === 0) {
    console.error('usage: node ktx2_dfd.mjs --check|--fix <file...>');
    process.exit(2);
  }
  let hit = 0, skipped = 0, failed = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    try {
      const { changed, bytes } = sizeBytesPlane0(buf);
      if (!changed) { skipped++; continue; }
      hit++;
      if (mode === '--fix') writeFileSync(f, buf);
      else console.log(`${f}: bytesPlane0 0 -> ${bytes}`);
    } catch (e) {
      failed++;
      console.error(`${f}: ${e.message}`);
    }
  }
  const verb = mode === '--fix' ? 'fixed' : 'would fix';
  console.log(`${verb} ${hit}, already conformant or uncompressed ${skipped}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
}
