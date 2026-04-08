// IScriptContext — language-agnostic interface for a script execution context.
//
// Replaces CLuaHandle as the engine's view of a running script instance.
// The engine never touches lua_State* or any interpreter internals;
// all interaction goes through this interface.
//
// Data exchange patterns:
//   - Events (engine → script): HandleEvent / HandleControlEvent
//   - Queries (script ← engine API): via registered API functions
//   - State (engine ↔ script): GetScriptData / SetScriptData for
//     named values the engine and script need to share
#pragma once

#include "ScriptPermissions.h"

#include <string>
#include <cstdint>

// Forward declarations
struct ScriptEvent;

class IScriptContext {
public:
    virtual ~IScriptContext() = default;

    // --- Identity ---
    virtual const std::string& GetName() const = 0;
    virtual int GetOrder() const = 0;  // dispatch priority (lower = first)

    // --- Permissions ---
    virtual const ScriptPermissions& GetPermissions() const = 0;
    virtual ScriptPermissions& GetPermissions() = 0;

    // --- Lifecycle ---
    virtual bool Init(const std::string& code, const std::string& source) = 0;
    virtual void Shutdown() = 0;
    virtual bool IsRunning() const = 0;

    // --- Event dispatch ---

    /// Check if this context has a handler for the given event.
    virtual bool WantsEvent(uint16_t eventType) const = 0;

    /// Dispatch a notification event (no return value).
    /// Called on the sim thread for synced contexts.
    virtual void HandleEvent(const ScriptEvent& event) = 0;

    /// Dispatch a control event that can alter sim state.
    /// Returns true if the context handled it (blocks further dispatch).
    virtual bool HandleControlEvent(ScriptEvent& event) = 0;

    // --- Garbage collection ---
    virtual void CollectGarbage(bool forced) = 0;

    // --- Script data exchange ---
    // These provide a generic way for the engine to read/write named
    // values in the script context without knowing the interpreter type.
    // Used for data that scripts expose to the engine (e.g. custom
    // unit properties, rule results, configuration).

    /// Get a float value from the script context. Returns def if not found.
    virtual float GetScriptFloat(const char* key, float def = 0.0f) const { (void)key; return def; }

    /// Get an integer value from the script context.
    virtual int GetScriptInt(const char* key, int def = 0) const { (void)key; return def; }

    /// Get a string value from the script context.
    virtual std::string GetScriptString(const char* key, const std::string& def = "") const { (void)key; return def; }

    /// Get a boolean value from the script context.
    virtual bool GetScriptBool(const char* key, bool def = false) const { (void)key; return def; }

    /// Set a named value in the script context.
    virtual void SetScriptFloat(const char* key, float value) { (void)key; (void)value; }
    virtual void SetScriptInt(const char* key, int value) { (void)key; (void)value; }
    virtual void SetScriptString(const char* key, const std::string& value) { (void)key; (void)value; }
    virtual void SetScriptBool(const char* key, bool value) { (void)key; (void)value; }

    // --- Inter-script messaging ---
    /// Receive a message from another script or the engine.
    virtual bool RecvMessage(const std::string& msg, int playerID) { (void)msg; (void)playerID; return false; }
};
