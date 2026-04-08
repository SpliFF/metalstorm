// ScriptPermissions — language-agnostic permission model for script contexts.
//
// Every script context (LuaRules, LuaGaia, AI VM, etc.) carries a
// ScriptPermissions struct that defines what game state it can read
// and modify. This replaces the scattered permission fields that were
// previously embedded in luaContextData and accessed via lua_State*.
#pragma once

struct ScriptPermissions {
    bool synced = false;        // true = affects game state (sim thread only)
    bool fullCtrl = false;      // can modify any team's units
    bool fullRead = false;      // can read any team's data
    bool allowChanges = false;  // currently allowed to make changes

    int ctrlTeam = -1;          // -1 = NoAccessTeam, -2 = AllAccessTeam
    int readTeam = 0;
    int readAllyTeam = 0;
    int selectTeam = -1;

    static constexpr int NoAccessTeam = -1;
    static constexpr int AllAccessTeam = -2;

    bool CanCtrlTeam(int team) const {
        if (fullCtrl) return true;
        if (ctrlTeam == AllAccessTeam) return true;
        return (ctrlTeam == team);
    }

    bool CanReadAllyTeam(int allyTeam) const {
        if (fullRead) return true;
        if (readAllyTeam == AllAccessTeam) return true;
        return (readAllyTeam == allyTeam);
    }
};
