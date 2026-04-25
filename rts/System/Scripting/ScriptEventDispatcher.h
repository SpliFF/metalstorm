// ScriptEventDispatcher — bridges CEventHandler to IScriptContext instances.
//
// Registered as a single CEventClient with the engine's EventHandler.
// Receives C++ pointer-based events, converts them to ScriptEvent with
// entity IDs, and dispatches to all registered IScriptContext instances
// in priority order.
//
// For control events (Allow*, CommandFallback), dispatches synchronously
// and returns the aggregated result.
#pragma once

#include "IScriptContext.h"
#include "ScriptEvent.h"
#include "System/EventClient.h"

#include <vector>

class ScriptEventDispatcher : public CEventClient {
public:
    ScriptEventDispatcher();
    ~ScriptEventDispatcher() override;

    /// Register with the engine's EventHandler.
    void Register();

    /// Add a script context. Contexts are dispatched in order priority.
    void AddContext(IScriptContext* ctx);

    /// Remove a script context.
    void RemoveContext(IScriptContext* ctx);

    /// Get all registered contexts.
    const std::vector<IScriptContext*>& GetContexts() const { return contexts; }

    // CEventClient overrides
    bool GetFullRead() const override { return true; }

    // --- CEventClient overrides (convert C++ events → ScriptEvent) ---

    void GamePreload() override;
    void GameStart() override;
    void GameOver(const std::vector<unsigned char>& winningAllyTeams) override;
    void GameFrame(int gameFrame) override;

    void TeamDied(int teamID) override;
    void TeamChanged(int teamID) override;
    void PlayerChanged(int playerID) override;
    void PlayerAdded(int playerID) override;
    void PlayerRemoved(int playerID, int reason) override;

    void UnitCreated(const CUnit* unit, const CUnit* builder) override;
    void UnitFinished(const CUnit* unit) override;
    void UnitFromFactory(const CUnit* unit, const CUnit* factory, bool userOrders) override;
    void UnitDestroyed(const CUnit* unit, const CUnit* attacker) override;
    void UnitTaken(const CUnit* unit, int oldTeam, int newTeam) override;
    void UnitGiven(const CUnit* unit, int oldTeam, int newTeam) override;
    void UnitIdle(const CUnit* unit) override;
    void UnitDamaged(const CUnit* unit, const CUnit* attacker,
                     float damage, int weaponDefID, int projectileID, bool paralyzer) override;
    void UnitMoved(const CUnit* unit) override;
    void UnitMoveFailed(const CUnit* unit) override;

    void FeatureCreated(const CFeature* feature) override;
    void FeatureDestroyed(const CFeature* feature) override;
    void FeatureDamaged(const CFeature* feature, const CUnit* attacker,
                        float damage, int weaponDefID, int projectileID) override;

    void ProjectileCreated(const CProjectile* proj) override;
    void ProjectileDestroyed(const CProjectile* proj) override;

    // Control events
    bool AllowCommand(const CUnit* unit, const Command& cmd,
                      int playerNum, bool fromSynced, bool fromLua) override;
    bool Explosion(int weaponID, int projectileID, const float3& pos, const CUnit* owner) override;

private:
    /// Dispatch a notification event to all contexts.
    void DispatchEvent(const ScriptEvent& event);

    /// Dispatch a control event. Returns the control result.
    bool DispatchControlEvent(ScriptEvent& event);

    std::vector<IScriptContext*> contexts;
};

/// Global script event dispatcher singleton.
extern ScriptEventDispatcher* scriptDispatcher;
