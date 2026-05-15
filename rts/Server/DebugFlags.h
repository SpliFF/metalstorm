// DebugFlags — runtime-toggleable verbose-logging switches for the
// test/debug harness.
//
// All flags default to `false` so production runs stay quiet. Toggle
// them via the `server` exec scope: `log <subsystem> on|off|status`.
// Subsystems: combat, sound, weapon, explosion, order, unit, script.
//
// Reads are unsynchronised by design — these flags only gate SLOG
// emission and a torn read just means one extra (or one missing) log
// line, never a sim-state divergence. Writes are atomic-store-only
// from the LuaExecEngine sim-thread thunk.
#pragma once

#include <atomic>
#include <string>

struct DebugFlags {
    std::atomic<bool> combat   {false};  // CombatEventCollector::Push
    std::atomic<bool> sound    {false};  // SoundEventCollector::Push
    std::atomic<bool> weapon   {false};  // CWeapon::Fire / Try*Target
    std::atomic<bool> explosion{false};  // Spring.SpawnExplosion + projectile impacts
    std::atomic<bool> order    {false};  // CCommandAI::GiveCommand
    std::atomic<bool> unit     {false};  // UnitCreated/Destroyed/Damaged hooks
    std::atomic<bool> script   {false};  // Lua callin entry/exit (very chatty)
};

extern DebugFlags g_debugFlags;

/// Resolve a subsystem name to the matching flag pointer, or nullptr
/// when the name does not match any known subsystem.
inline std::atomic<bool>* DebugFlagByName(const std::string& name) {
    if (name == "combat")    return &g_debugFlags.combat;
    if (name == "sound")     return &g_debugFlags.sound;
    if (name == "weapon")    return &g_debugFlags.weapon;
    if (name == "explosion") return &g_debugFlags.explosion;
    if (name == "order")     return &g_debugFlags.order;
    if (name == "unit")      return &g_debugFlags.unit;
    if (name == "script")    return &g_debugFlags.script;
    return nullptr;
}

/// True when at least one DebugFlag is currently on.
inline bool AnyDebugFlagOn() {
    return g_debugFlags.combat   .load(std::memory_order_relaxed)
        || g_debugFlags.sound    .load(std::memory_order_relaxed)
        || g_debugFlags.weapon   .load(std::memory_order_relaxed)
        || g_debugFlags.explosion.load(std::memory_order_relaxed)
        || g_debugFlags.order    .load(std::memory_order_relaxed)
        || g_debugFlags.unit     .load(std::memory_order_relaxed)
        || g_debugFlags.script   .load(std::memory_order_relaxed);
}
