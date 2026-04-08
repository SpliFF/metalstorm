// LuaScriptContext — wraps CLuaHandle for the scripting abstraction.

#include "LuaScriptContext.h"
#include "LuaHandle.h"
#include "LuaContextData.h"
#include "LuaInclude.h"

#include "System/Scripting/ScriptEvent.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"

LuaScriptContext::LuaScriptContext(CLuaHandle* handle)
    : handle(handle)
{
    // Sync permissions from luaContextData
    if (handle && handle->GetLuaState()) {
        auto* lcd = GetLuaContextData(handle->GetLuaState());
        if (lcd) {
            permissions.synced = lcd->synced;
            permissions.fullCtrl = lcd->fullCtrl;
            permissions.fullRead = lcd->fullRead;
            permissions.allowChanges = lcd->allowChanges;
            permissions.ctrlTeam = lcd->ctrlTeam;
            permissions.readTeam = lcd->readTeam;
            permissions.readAllyTeam = lcd->readAllyTeam;
            permissions.selectTeam = lcd->selectTeam;
        }
    }
}

const std::string& LuaScriptContext::GetName() const {
    return handle->GetName();
}

int LuaScriptContext::GetOrder() const {
    return handle->GetOrder();
}

const ScriptPermissions& LuaScriptContext::GetPermissions() const {
    return permissions;
}

ScriptPermissions& LuaScriptContext::GetPermissions() {
    return permissions;
}

bool LuaScriptContext::Init(const std::string& code, const std::string& source) {
    // CLuaHandle is initialized separately through its own Init path
    (void)code; (void)source;
    return true;
}

void LuaScriptContext::Shutdown() {
    // CLuaHandle manages its own shutdown
}

bool LuaScriptContext::IsRunning() const {
    return handle && handle->IsRunning();
}

bool LuaScriptContext::WantsEvent(uint16_t eventType) const {
    // For now, accept all events — CLuaHandle checks internally
    (void)eventType;
    return true;
}

void LuaScriptContext::HandleEvent(const ScriptEvent& event) {
    if (!handle) return;

    // Delegate to CLuaHandle's existing methods.
    // This bridges ScriptEvent entity IDs back to C++ pointers
    // that CLuaHandle expects. Over time, CLuaHandle methods should
    // be refactored to accept IDs directly.
    switch (event.type) {
        case ScriptEventType::GameFrame:
            handle->GameFrame(event.intData[0]);
            break;
        case ScriptEventType::GameStart:
            handle->GameStart();
            break;
        case ScriptEventType::GamePreload:
            handle->GamePreload();
            break;
        case ScriptEventType::UnitCreated: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            CUnit* builder = event.entityId2 ? unitHandler.GetUnit(event.entityId2) : nullptr;
            if (unit) handle->UnitCreated(unit, builder);
            break;
        }
        case ScriptEventType::UnitFinished: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            if (unit) handle->UnitFinished(unit);
            break;
        }
        case ScriptEventType::UnitDestroyed: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            CUnit* attacker = event.entityId2 ? unitHandler.GetUnit(event.entityId2) : nullptr;
            if (unit) handle->UnitDestroyed(unit, attacker);
            break;
        }
        case ScriptEventType::UnitIdle: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            if (unit) handle->UnitIdle(unit);
            break;
        }
        case ScriptEventType::UnitDamaged: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            CUnit* attacker = event.entityId2 ? unitHandler.GetUnit(event.entityId2) : nullptr;
            if (unit) {
                handle->UnitDamaged(unit, attacker,
                    event.floatData[0], event.intData[0],
                    event.intData[1], event.intData[2] != 0);
            }
            break;
        }
        case ScriptEventType::UnitMoved: {
            CUnit* unit = unitHandler.GetUnit(event.entityId);
            if (unit) handle->UnitMoved(unit);
            break;
        }
        case ScriptEventType::TeamDied:
            handle->TeamDied(event.intData[0]);
            break;
        case ScriptEventType::PlayerChanged:
            handle->PlayerChanged(event.intData[0]);
            break;
        default:
            // Events not yet bridged — the CLuaHandle still receives
            // them directly from CEventHandler for now
            break;
    }
}

bool LuaScriptContext::HandleControlEvent(ScriptEvent& event) {
    if (!handle) return false;

    switch (event.type) {
        case ScriptEventType::Explosion:
            event.controlResult = handle->Explosion(
                event.intData[0], event.intData[1],
                event.position, nullptr); // owner lookup would go here
            return event.controlResult;
        default:
            return false;
    }
}

void LuaScriptContext::CollectGarbage(bool forced) {
    if (handle)
        handle->CollectGarbage(forced);
}

// --- Script data exchange ---
// These query/set Lua global variables via the lua_State

float LuaScriptContext::GetScriptFloat(const char* key, float def) const {
    if (!handle || !handle->GetLuaState()) return def;
    lua_State* L = handle->GetLuaState();
    lua_getglobal(L, key);
    float result = lua_isnumber(L, -1) ? lua_tofloat(L, -1) : def;
    lua_pop(L, 1);
    return result;
}

int LuaScriptContext::GetScriptInt(const char* key, int def) const {
    if (!handle || !handle->GetLuaState()) return def;
    lua_State* L = handle->GetLuaState();
    lua_getglobal(L, key);
    int result = lua_isinteger(L, -1) ? static_cast<int>(lua_tointeger(L, -1)) : def;
    lua_pop(L, 1);
    return result;
}

std::string LuaScriptContext::GetScriptString(const char* key, const std::string& def) const {
    if (!handle || !handle->GetLuaState()) return def;
    lua_State* L = handle->GetLuaState();
    lua_getglobal(L, key);
    std::string result = lua_isstring(L, -1) ? lua_tostring(L, -1) : def;
    lua_pop(L, 1);
    return result;
}

bool LuaScriptContext::GetScriptBool(const char* key, bool def) const {
    if (!handle || !handle->GetLuaState()) return def;
    lua_State* L = handle->GetLuaState();
    lua_getglobal(L, key);
    bool result = lua_isboolean(L, -1) ? lua_toboolean(L, -1) : def;
    lua_pop(L, 1);
    return result;
}

void LuaScriptContext::SetScriptFloat(const char* key, float value) {
    if (!handle || !handle->GetLuaState()) return;
    lua_State* L = handle->GetLuaState();
    lua_pushnumber(L, value);
    lua_setglobal(L, key);
}

void LuaScriptContext::SetScriptInt(const char* key, int value) {
    if (!handle || !handle->GetLuaState()) return;
    lua_State* L = handle->GetLuaState();
    lua_pushinteger(L, value);
    lua_setglobal(L, key);
}

void LuaScriptContext::SetScriptString(const char* key, const std::string& value) {
    if (!handle || !handle->GetLuaState()) return;
    lua_State* L = handle->GetLuaState();
    lua_pushsstring(L, value);
    lua_setglobal(L, key);
}

void LuaScriptContext::SetScriptBool(const char* key, bool value) {
    if (!handle || !handle->GetLuaState()) return;
    lua_State* L = handle->GetLuaState();
    lua_pushboolean(L, value);
    lua_setglobal(L, key);
}

bool LuaScriptContext::RecvMessage(const std::string& msg, int playerID) {
    if (!handle) return false;
    return handle->RecvLuaMsg(msg, playerID);
}
