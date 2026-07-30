/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef DAMAGE_FIELD_H
#define DAMAGE_FIELD_H

#include <cstdint>
#include <vector>

#include "System/creg/creg_cond.h"
#include "System/float3.h"

// ---------------------------------------------------------------------------
// Metalstorm damage fields (Model 3 — area bombardment, C6).
//
// PLAN-metalstorm-combat-resolution.md §4. A damage field is a persistent
// AREA that applies `intensity` damage/second on a fixed frame cadence for a
// bounded duration, created by game Lua (`Spring.CreateDamageField`) or, in a
// later step, by `field`-resolution weapons bombarding a region. Units inside
// the area take damage through the normal CUnit::DoDamage path (attacker = the
// field's owner unit if still alive, else no attacker), so every downstream
// system (CombatEventCollector, UnitDamaged callin, objectives) works
// unchanged.
//
// This is an OPT-IN Metalstorm mechanic — game Lua must explicitly create a
// field. The faithful Recoil path never produces one, so no ported game is
// affected (AGENTS.md "Faithful Recoil Reproduction": a called-out, opt-in
// addition, not a silent substitution of standard behaviour).
//
// The manager (field list + evaluator) is creg-registered so persistent
// barrages survive save/load (E4). The client receives only Created/Removed
// lifecycle events and invents the barrage FX procedurally — the sim owns all
// damage (§5 sim/client split).
// ---------------------------------------------------------------------------

enum DamageFieldShapeType : uint8_t {
  DAMAGE_FIELD_CIRCLE = 0, // center + radius
  DAMAGE_FIELD_RECT = 1,   // center + (halfX, halfZ) axis-aligned box
};

// A single active damage field. Geometry helpers are pure (no world access)
// so the evaluator's decisions are directly unit-testable.
struct DamageField {
  CR_DECLARE_STRUCT(DamageField)

  uint32_t id = 0;
  uint8_t shape = DAMAGE_FIELD_CIRCLE;
  float3 center;          // xz used; y is a ground sample for FX
  float radius = 0.0f;    // circle radius / rect half-extent along x
  float halfZ = 0.0f;     // rect half-extent along z (unused for circle)
  int weaponDefId = -1;   // damage type (armor class); -1 => plain damage
  float intensity = 0.0f; // damage per game-second
  int cadence = 15;       // frames between damage ticks (>=1)
  int nextTickFrame = 0;  // next frame this field applies damage
  int expireFrame = 0;    // frame at/after which the field is removed
  int ownerUnitId = -1;   // firing/creating unit (attacker for DoDamage)
  uint16_t ownerGen = 0;  // owner spawn generation (id-reuse guard)
  int ownerTeam = 255;    // owner team (0..n); 255 = neutral/none
  // FRIENDLY-FIRE CHOICE (called-out gameplay divergence): a field damages
  // only units NOT allied to `ownerTeam` by default, so a player laying a
  // barrage on an enemy region never nukes their own troops. Set true (Lua
  // `friendlyFire`) for a true indiscriminate bombardment. Neutral-owner
  // (255) fields always hit everyone.
  bool friendlyFire = false;

  // Damage applied at one cadence tick: intensity scaled by the tick's
  // wall-time slice (cadence frames / GAME_SPEED). Pure.
  float PerTickDamage() const;

  // Is world point `p` inside the field area (xz only)? Pure.
  bool Contains(const float3 &p) const;

  // Bounding radius for a coarse quadfield pre-query (rect → its diagonal).
  float QueryRadius() const;
};

// One damage-field lifecycle change for the wire (Created / Removed). Snapshot
// of the field at the moment it changed; the client invents FX from it.
struct DamageFieldEventData {
  uint32_t fieldId = 0;
  uint8_t kind = 0; // 0 = Created, 1 = Removed
  uint8_t shape = 0;
  float3 center;
  float radius = 0.0f;
  float halfZ = 0.0f;
  uint16_t weaponDefId = 0;
  float intensity = 0.0f;
  uint16_t cadence = 15;
  uint32_t duration = 0; // remaining frames at create; 0 for Removed
  uint8_t team = 255;
};

// Owns the active field list; evaluated once per sim frame (Simulation.cpp,
// right after statisticalCombatManager.Update). creg-registered so fields
// survive save/load (E4). Wire events are drained separately each tick.
class DamageFieldManager {
  CR_DECLARE_STRUCT(DamageFieldManager)

public:
  void Init();
  void Kill();

  // Create a field. `ownerTeam` attributes damage + drives friendly-fire
  // filtering; `ownerUnitId` (-1 = none) is the DoDamage attacker while it
  // lives. `durationFrames` <= 0 is rejected (fields must be bounded).
  // `centerY` is stamped for client FX. Returns the new field id (0 on
  // rejection). Pushes a Created event.
  uint32_t Create(uint8_t shape, const float3 &center, float radius,
                  float halfZ, int weaponDefId, float intensity, int cadence,
                  int durationFrames, int ownerUnitId, int ownerTeam,
                  bool friendlyFire, int currentFrame);

  // Remove a field early. `team` must match the owner (or -1 to bypass the
  // check, for engine-initiated removal). Returns false on id mismatch or
  // cross-team attempt. Pushes a Removed event.
  bool Remove(uint32_t fieldId, int team);

  // Per-frame evaluator: expire finished fields (Removed events), then apply
  // damage for every field reaching a cadence tick this frame via DoDamage.
  void Update(int frame);

  // Pure scheduling half of Update(), exposed for tests: expire fields past
  // their end (moving their ids into `expiredOut`, pushing Removed events),
  // then return a copy of every field that reaches a cadence tick at
  // `frame` (advancing each field's nextTickFrame). No world access.
  std::vector<DamageField>
  CollectDamageTicks(int frame, std::vector<uint32_t> &expiredOut);

  // Drain the pending wire events (Created / Removed) collected this tick.
  std::vector<DamageFieldEventData> DrainEvents();

  const std::vector<DamageField> &GetAll() const { return fields; }
  size_t FieldCount() const { return fields.size(); }

private:
  std::vector<DamageField> fields;
  uint32_t nextId = 1;

  // Wire events since the last drain. NOT creg-registered: transient, drained
  // every tick by StateStreamer. A field that survives save/load re-announces
  // via a fresh Created event on the next Create is NOT re-emitted — instead
  // the client rebuilds fields lazily; see §4 (a lost Created just means one
  // missing barrage until the field re-ticks — accepted, invisible).
  std::vector<DamageFieldEventData> pendingEvents;

  DamageFieldEventData MakeEvent(const DamageField &f, uint8_t kind,
                                 int currentFrame) const;
};

extern DamageFieldManager damageFieldManager;

#endif // DAMAGE_FIELD_H
