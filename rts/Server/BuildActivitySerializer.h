/**
 * BuildActivitySerializer — per-tick "who is nano-spraying whom" snapshot.
 *
 * Drives the client's nano-beam renderer (BuildBeamRenderer). Sent under
 * envelope byte 0x06 at the same ~10 Hz cadence as projectile state.
 *
 *   Header (6 bytes):
 *     u32 frame
 *     u16 builder_count
 *
 *   Per-builder block (variable length):
 *     u32 builder_id            // unit doing the work
 *     u32 target_id             // 0 = no entity target (terraform / restore)
 *                                // 0xFFFFFFFE = feature reclaim/resurrect
 *     f32 target_x, target_y, target_z
 *     f32 target_radius         // visual cone radius at the target end
 *     u8  kind                  // 0=build 1=repair 2=reclaim 3=resurrect
 *                                // 4=capture 5=terraform
 *     u8  piece_count           // emitter pieces on this builder
 *     u8  pieces[piece_count]   // model-piece indices, from NanoPieceCache
 *     f32 strength              // builder's effective build power, 0..1+
 *
 * The envelope byte 0x06 is prepended by the caller.
 *
 * Visibility: enemy build activity respects LOS the same way the entity
 * state stream does (own-allyteam unconditionally, enemies only if seen).
 * Pass `viewerAllyTeam < 0` for spectators / dev sessions to skip the
 * filter entirely.
 */
#pragma once

#include <cstdint>
#include <vector>

namespace BuildActivity {

// Encoded into the per-builder `kind` byte.
constexpr uint8_t KIND_BUILD     = 0;
constexpr uint8_t KIND_REPAIR    = 1;
constexpr uint8_t KIND_RECLAIM   = 2;
constexpr uint8_t KIND_RESURRECT = 3;
constexpr uint8_t KIND_CAPTURE   = 4;
constexpr uint8_t KIND_TERRAFORM = 5;

// Sentinel target_id used when the target is a CFeature rather than a
// CUnit — the client knows to look at target_pos instead of doing an
// entity-id lookup.
constexpr uint32_t TARGET_FEATURE = 0xFFFFFFFEu;

/// Serialize all currently-active build interactions across the live
/// unit set. Returns an empty buffer when no builder is doing anything.
/// `frame` is the sim frame number stamped into the header.
std::vector<uint8_t> SerializeAll(uint32_t frame, int viewerAllyTeam = -1);

} // namespace BuildActivity
