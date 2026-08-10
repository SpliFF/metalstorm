/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef KTX2_BYTES_PLANE_H
#define KTX2_BYTES_PLANE_H

#include <cstddef>
#include <cstdint>

/**
 * `bytesPlane0` in a KTX2 file's basic data format descriptor, and where
 * to find it.
 *
 * KTX2 ≤ 2.0.3 said a supercompressed file's `bytesPlane0..7` must be
 * *unsized* (all zero) because the bytes on disk are not the bytes the
 * DFD describes. Spec 2.0.4 reversed that: the DFD describes the
 * *inflated* texel block, which is a fixed size the reader needs before
 * it has inflated anything, so `bytesPlane0` must be non-zero. libktx
 * 4.3.2 — the version this tree links (top-level CMakeLists.txt) — still
 * implements the old rule and zeroes the word at the end of
 * `ktxTexture2_DeflateZstd` (`lib/writer2.c`, "Clear bytesPlane to
 * indicate we're now unsized"); libktx 4.4 dropped that line. So every
 * Zstd-supercompressed file we write trips the Khronos validator's
 * `warning-6030`, and the fix is to put the pre-deflate word back.
 *
 * `ktx validate` reports 6030 as a warning and still exits 0, so nothing
 * in the pipeline was blocked by it and nothing renders wrong — the
 * 62 `toktx v4.4.2`-written textures already in `data/games/metalstorm/
 * models/` carry a sized `bytesPlane0` and load in the same client, in
 * the same directory, as the ones that do not. It is a correctness
 * defect against the spec we claim to write, found the same way as the
 * `KTXorientation` bug next door in Ktx2Orientation.h. See PLAN-maps.md
 * M8f/M9i.
 *
 * Header-only and dependency-free on purpose, for the same reason as
 * Ktx2Orientation.h: `textureconverter` links libktx and `spring-tests`
 * does not, so the offsets and the derivation have to live somewhere
 * both can include.
 */
namespace ktx2 {

/// Word index of `bytesPlane3..0` inside a *basic* DFD block, matching
/// `KHR_DF_WORD_BYTESPLANE0` in Khronos' `khr_df.h`. libktx's
/// `ktxTexture2::pDfd` points at the DFD's total-size word, so the basic
/// block starts one word later — index this against `pDfd + 1`.
inline constexpr size_t kBdfdWordBytesPlane0 = 4;

/// Companion word holding `bytesPlane7..4` (`KHR_DF_WORD_BYTESPLANE4`).
/// Always 0 for every format we write; carried so a save/restore pair
/// covers the whole field rather than half of it.
inline constexpr size_t kBdfdWordBytesPlane4 = 5;

/// `bytesPlane0` is the low byte of its word — the other three bytes are
/// `bytesPlane1..3`, which are non-zero only for planar (multi-plane)
/// formats we never write.
constexpr uint32_t BytesPlane0Of(uint32_t bytesPlane0Word) {
	return bytesPlane0Word & 0xFFu;
}

/// Spec 2.0.4's rule, as a predicate: a supercompressed file's DFD is
/// legal only when `bytesPlane0` is sized. Unsupercompressed files are
/// unaffected (libktx never clears the word for them).
constexpr bool IsSizedForSupercompression(uint32_t bytesPlane0Word) {
	return BytesPlane0Of(bytesPlane0Word) != 0;
}

} // namespace ktx2

#endif // KTX2_BYTES_PLANE_H
