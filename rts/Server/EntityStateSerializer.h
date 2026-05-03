/**
 * EntityStateSerializer — builds Tier 2 binary entity state updates.
 *
 * Per PLAN-network.md, the format is struct-of-arrays for zero-copy
 * TypedArray access on the client:
 *
 *   Header (4 bytes):
 *     u16 entity_count
 *     u16 field_mask        (which fields are present)
 *
 *   Per-field arrays (contiguous, only present if bit set):
 *     Bit 0: entity_ids    → u32[count]
 *     Bit 1: positions_x   → f32[count]
 *     Bit 2: positions_y   → f32[count]
 *     Bit 3: positions_z   → f32[count]
 *     Bit 4: headings      → u16[count]    (0-65535 → 0°-360°)
 *     Bit 5: health        → u16[count]    (0-65535 → 0%-100%)
 *     Bit 6: def_id        → u16[count]
 *     Bit 7: team          → u8[count]
 *     Bit 8: state_bits    → u8[count]     (packed unit-state flags)
 *     Bit 9: los_state     → u8[count]     (Spring losStatus, low 4 bits)
 *     Bit 10: build_progress → u8[count]   (0-255 → 0%-100%, 255 = finished)
 *
 *   los_state layout (per unit, for the receiving session's ally team):
 *     bit 0: LOS_INLOS      — fully in line of sight
 *     bit 1: LOS_INRADAR    — in radar coverage
 *     bit 2: LOS_PREVLOS    — previously seen ("ghost")
 *     bit 3: LOS_CONTRADAR  — continuously on radar since last sighting
 *     bits 4-7 reserved
 *
 *   state_bits layout (per unit):
 *     bits 0-1: fireState  (0=hold, 1=return, 2=at-will)
 *     bits 2-3: moveState  (0=hold, 1=maneuver, 2=roam)
 *     bit  4:   repeatOrders
 *     bit  5:   isCloaked
 *     bit  6:   isStunned
 *     bit  7:   reserved (shield_active in a future revision)
 *
 * The envelope byte 0x02 is prepended by the caller.
 */
#pragma once

#include <cstdint>
#include <vector>

class CUnit;
struct Viewport;

namespace EntityState {

constexpr uint16_t FIELD_ENTITY_IDS  = 1 << 0;
constexpr uint16_t FIELD_POSITION_X  = 1 << 1;
constexpr uint16_t FIELD_POSITION_Y  = 1 << 2;
constexpr uint16_t FIELD_POSITION_Z  = 1 << 3;
constexpr uint16_t FIELD_HEADING     = 1 << 4;
constexpr uint16_t FIELD_HEALTH      = 1 << 5;
constexpr uint16_t FIELD_DEF_ID      = 1 << 6;
constexpr uint16_t FIELD_TEAM        = 1 << 7;
constexpr uint16_t FIELD_STATE_BITS  = 1 << 8;
constexpr uint16_t FIELD_LOS_STATE   = 1 << 9;
constexpr uint16_t FIELD_BUILD_PROGRESS = 1 << 10;

// All fields — used for full state snapshots
constexpr uint16_t FIELD_ALL = 0x07FF;

/// Serialize all active units into the Tier 2 binary format.
/// Returns a buffer ready to be sent (without envelope byte).
std::vector<uint8_t> SerializeAllUnits(uint16_t fieldMask = FIELD_ALL);

/// Serialize a specific set of units.
/// `viewerAllyTeam` determines what gets written into the per-unit
/// FIELD_LOS_STATE byte (Spring's losStatus[allyTeam]). Pass -1 for
/// permissive sessions (everything reads as fully visible).
std::vector<uint8_t> SerializeUnits(
    const std::vector<CUnit*>& units,
    uint16_t fieldMask = FIELD_ALL,
    int viewerAllyTeam = -1);

/// Serialize units visible within a set of viewports.
/// Uses QuadField spatial queries. Requires a loaded map.
std::vector<uint8_t> SerializeViewportUnits(
    const Viewport* viewports, int numViewports,
    uint16_t fieldMask = FIELD_ALL);

/// Collect units visible within a set of viewports (without serializing).
/// Used when the caller needs to apply delta filtering before serialization.
///
/// When `viewerAllyTeam >= 0`, results are filtered for that ally team's
/// visibility: every own-allyteam unit is included unconditionally, and
/// enemy units are only included if losHandler reports them in LOS. Pass
/// -1 to disable the per-team filter (returns everything in the viewport
/// regardless of ownership — used for the legacy dev-mode permissive
/// path and for spectators who should see everything).
std::vector<CUnit*> CollectViewportUnits(
    const Viewport* viewports, int numViewports,
    int viewerAllyTeam = -1);

/// Collect all active (non-dead) units.
///
/// When `viewerAllyTeam >= 0`, applies the same per-ally-team visibility
/// filter as CollectViewportUnits. This is the no-viewport fallback path
/// used when a session has no active viewport registered yet.
std::vector<CUnit*> CollectAllUnits(int viewerAllyTeam = -1);

} // namespace EntityState
