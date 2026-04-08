// LuaScriptContext — adapts CLuaHandle to the IScriptContext interface.
//
// This is a thin adapter that wraps an existing CLuaHandle and delegates
// ScriptEvent dispatches back to the CLuaHandle's existing call-in methods.
// It bridges the new abstraction with the existing Lua code, allowing
// incremental migration without rewriting everything at once.
//
// The CLuaHandle still registers directly with CEventHandler for now.
// Once all events are routed through ScriptEventDispatcher, the direct
// registration can be removed.
#pragma once

#include "System/Scripting/IScriptContext.h"
#include "System/Scripting/ScriptPermissions.h"

class CLuaHandle;
struct lua_State;

class LuaScriptContext : public IScriptContext {
public:
    explicit LuaScriptContext(CLuaHandle* handle);
    ~LuaScriptContext() override = default;

    // --- IScriptContext ---
    const std::string& GetName() const override;
    int GetOrder() const override;
    const ScriptPermissions& GetPermissions() const override;
    ScriptPermissions& GetPermissions() override;

    bool Init(const std::string& code, const std::string& source) override;
    void Shutdown() override;
    bool IsRunning() const override;

    bool WantsEvent(uint16_t eventType) const override;
    void HandleEvent(const ScriptEvent& event) override;
    bool HandleControlEvent(ScriptEvent& event) override;

    void CollectGarbage(bool forced) override;

    // Script data exchange (queries Lua global variables)
    float GetScriptFloat(const char* key, float def) const override;
    int GetScriptInt(const char* key, int def) const override;
    std::string GetScriptString(const char* key, const std::string& def) const override;
    bool GetScriptBool(const char* key, bool def) const override;

    void SetScriptFloat(const char* key, float value) override;
    void SetScriptInt(const char* key, int value) override;
    void SetScriptString(const char* key, const std::string& value) override;
    void SetScriptBool(const char* key, bool value) override;

    bool RecvMessage(const std::string& msg, int playerID) override;

    /// Get the underlying Lua handle (for code still using CLuaHandle directly).
    CLuaHandle* GetLuaHandle() { return handle; }

private:
    CLuaHandle* handle;
    ScriptPermissions permissions;
};
