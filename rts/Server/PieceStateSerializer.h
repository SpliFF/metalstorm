/**
 * PieceStateSerializer — per-unit local-model piece transforms.
 *
 * Spring's COB / Lua unit scripts animate model pieces (turret turns,
 * walking legs, recoil, etc.) by mutating each LocalModelPiece's
 * `pos` and `rot` fields. The synced sim only ever reads these for
 * weapon-fire positions; the rest is purely cosmetic and so used to
 * live in the now-deleted client-side renderer.
 *
 * This serialiser snapshots the animated piece state and ships it to
 * each client. Format under envelope byte 0x05:
 *
 *   Header (6 bytes):
 *     u32 frame
 *     u16 unit_count
 *
 *   Per-unit block (variable length):
 *     u32 unit_id
 *     u8  piece_count
 *     [u8 piece_idx, f32 px, f32 py, f32 pz, f32 rx, f32 ry, f32 rz]
 *       × piece_count
 *
 * `pos` is the absolute piece position in its parent's frame (rest
 * pose has it equal to the piece's offset from its parent), and
 * `rot` is Euler XYZ in radians (rest = 0,0,0). The client knows the
 * rest-pose offset per piece from its own GLB import and overrides
 * the local matrix when it receives a transform here.
 *
 * Only pieces that have been animated (pos != rest_offset OR rot ≠ 0)
 * are emitted; static pieces stay implicit at their rest pose.
 *
 * The envelope byte 0x05 is prepended by the caller.
 */
#pragma once

#include <cstdint>
#include <vector>

class CUnit;

namespace PieceState {

/// Serialize per-piece animated transforms for a set of units.
/// Pieces matching their rest pose are skipped entirely; units with
/// no animated pieces are not emitted in the per-unit block list.
/// Returns a buffer ready to be sent (without envelope byte). Returns
/// an empty buffer when no unit has any animated pieces.
std::vector<uint8_t> SerializeUnits(
    const std::vector<CUnit*>& units,
    uint32_t frame);

} // namespace PieceState
