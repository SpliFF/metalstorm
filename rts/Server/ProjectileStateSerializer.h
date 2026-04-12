/**
 * ProjectileStateSerializer — builds binary projectile state snapshots.
 *
 * Same struct-of-arrays approach as EntityStateSerializer for zero-copy
 * TypedArray access on the client. Sent under envelope 0x04.
 *
 *   Header (4 bytes):
 *     u16 projectile_count
 *     u16 field_mask
 *
 *   Per-field arrays (contiguous, only present if bit set):
 *     Bit 0: projectile_ids   → u32[count]
 *     Bit 1: weapon_def_ids   → u16[count]
 *     Bit 2: positions_x      → f32[count]
 *     Bit 3: positions_y      → f32[count]
 *     Bit 4: positions_z      → f32[count]
 *     Bit 5: dir_x            → f32[count]
 *     Bit 6: dir_y            → f32[count]
 *     Bit 7: dir_z            → f32[count]
 *     Bit 8: team             → u8[count]
 */
#pragma once

#include <cstdint>
#include <vector>

namespace ProjectileState {

constexpr uint16_t FIELD_PROJ_IDS       = 1 << 0;
constexpr uint16_t FIELD_WEAPON_DEF_ID  = 1 << 1;
constexpr uint16_t FIELD_POSITION_X     = 1 << 2;
constexpr uint16_t FIELD_POSITION_Y     = 1 << 3;
constexpr uint16_t FIELD_POSITION_Z     = 1 << 4;
constexpr uint16_t FIELD_DIR_X          = 1 << 5;
constexpr uint16_t FIELD_DIR_Y          = 1 << 6;
constexpr uint16_t FIELD_DIR_Z          = 1 << 7;
constexpr uint16_t FIELD_TEAM           = 1 << 8;

constexpr uint16_t FIELD_ALL = 0x01FF;

/// Serialize all active synced weapon projectiles into the binary format.
/// Returns a buffer ready to be sent (without envelope byte).
std::vector<uint8_t> SerializeAllProjectiles(uint16_t fieldMask = FIELD_ALL);

} // namespace ProjectileState
