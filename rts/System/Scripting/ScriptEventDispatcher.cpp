// ScriptEventDispatcher — bridges CEventHandler to IScriptContext.

#include "ScriptEventDispatcher.h"

#include "Sim/Units/Unit.h"
#include "Sim/Features/Feature.h"
#include "Sim/Projectiles/Projectile.h"
#include "Sim/Units/CommandAI/Command.h"
#include "System/EventHandler.h"

#include <algorithm>
#include <cstdio>

ScriptEventDispatcher* scriptDispatcher = nullptr;

ScriptEventDispatcher::ScriptEventDispatcher()
    : CEventClient("ScriptEventDispatcher", 0, true)
{
}

ScriptEventDispatcher::~ScriptEventDispatcher() = default;

void ScriptEventDispatcher::Register() {
    eventHandler.AddClient(this);
}

void ScriptEventDispatcher::AddContext(IScriptContext* ctx) {
    contexts.push_back(ctx);
    // Sort by order (lower first)
    std::sort(contexts.begin(), contexts.end(),
        [](const IScriptContext* a, const IScriptContext* b) {
            return a->GetOrder() < b->GetOrder();
        });
}

void ScriptEventDispatcher::RemoveContext(IScriptContext* ctx) {
    contexts.erase(
        std::remove(contexts.begin(), contexts.end(), ctx),
        contexts.end());
}

void ScriptEventDispatcher::DispatchEvent(const ScriptEvent& event) {
    for (auto* ctx : contexts) {
        if (ctx->WantsEvent(event.type))
            ctx->HandleEvent(event);
    }
}

bool ScriptEventDispatcher::DispatchControlEvent(ScriptEvent& event) {
    for (auto* ctx : contexts) {
        if (!ctx->WantsEvent(event.type))
            continue;
        if (ctx->HandleControlEvent(event))
            return !event.controlResult; // true = blocked
    }
    return false; // no context blocked it
}

// === Notification events ===

void ScriptEventDispatcher::GamePreload() {
    ScriptEvent e;
    e.type = ScriptEventType::GamePreload;
    DispatchEvent(e);
}

void ScriptEventDispatcher::GameStart() {
    ScriptEvent e;
    e.type = ScriptEventType::GameStart;
    DispatchEvent(e);
}

void ScriptEventDispatcher::GameOver(const std::vector<unsigned char>& winningAllyTeams) {
    ScriptEvent e;
    e.type = ScriptEventType::GameOver;
    (void)winningAllyTeams; // TODO: encode winning teams
    DispatchEvent(e);
}

void ScriptEventDispatcher::GameFrame(int gameFrame) {
    DispatchEvent(ScriptEvent::GameFrameEvent(gameFrame));
}

void ScriptEventDispatcher::TeamDied(int teamID) {
    ScriptEvent e;
    e.type = ScriptEventType::TeamDied;
    e.intData[0] = teamID;
    DispatchEvent(e);
}

void ScriptEventDispatcher::TeamChanged(int teamID) {
    ScriptEvent e;
    e.type = ScriptEventType::TeamChanged;
    e.intData[0] = teamID;
    DispatchEvent(e);
}

void ScriptEventDispatcher::PlayerChanged(int playerID) {
    ScriptEvent e;
    e.type = ScriptEventType::PlayerChanged;
    e.intData[0] = playerID;
    DispatchEvent(e);
}

void ScriptEventDispatcher::PlayerAdded(int playerID) {
    ScriptEvent e;
    e.type = ScriptEventType::PlayerAdded;
    e.intData[0] = playerID;
    DispatchEvent(e);
}

void ScriptEventDispatcher::PlayerRemoved(int playerID, int reason) {
    ScriptEvent e;
    e.type = ScriptEventType::PlayerRemoved;
    e.intData[0] = playerID;
    e.intData[1] = reason;
    DispatchEvent(e);
}

// === Unit events ===

void ScriptEventDispatcher::UnitCreated(const CUnit* unit, const CUnit* builder) {
    DispatchEvent(ScriptEvent::UnitEvent(
        ScriptEventType::UnitCreated,
        unit ? unit->id : 0,
        builder ? builder->id : 0));
}

void ScriptEventDispatcher::UnitFinished(const CUnit* unit) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::UnitFinished, unit->id));
}

void ScriptEventDispatcher::UnitFromFactory(const CUnit* unit, const CUnit* factory, bool userOrders) {
    auto e = ScriptEvent::UnitEvent(ScriptEventType::UnitFromFactory, unit->id, factory->id);
    e.intData[0] = userOrders ? 1 : 0;
    DispatchEvent(e);
}

void ScriptEventDispatcher::UnitDestroyed(const CUnit* unit, const CUnit* attacker) {
    DispatchEvent(ScriptEvent::UnitEvent(
        ScriptEventType::UnitDestroyed, unit->id,
        attacker ? attacker->id : 0));
}

void ScriptEventDispatcher::UnitTaken(const CUnit* unit, int oldTeam, int newTeam) {
    auto e = ScriptEvent::UnitEvent(ScriptEventType::UnitTaken, unit->id);
    e.intData[0] = oldTeam;
    e.intData[1] = newTeam;
    DispatchEvent(e);
}

void ScriptEventDispatcher::UnitGiven(const CUnit* unit, int oldTeam, int newTeam) {
    auto e = ScriptEvent::UnitEvent(ScriptEventType::UnitGiven, unit->id);
    e.intData[0] = oldTeam;
    e.intData[1] = newTeam;
    DispatchEvent(e);
}

void ScriptEventDispatcher::UnitIdle(const CUnit* unit) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::UnitIdle, unit->id));
}

void ScriptEventDispatcher::UnitDamaged(
    const CUnit* unit, const CUnit* attacker,
    float damage, int weaponDefID, int projectileID, bool paralyzer)
{
    DispatchEvent(ScriptEvent::DamageEvent(
        unit->id,
        attacker ? attacker->id : 0,
        damage, weaponDefID, projectileID, paralyzer));
}

void ScriptEventDispatcher::UnitMoved(const CUnit* unit) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::UnitMoved, unit->id));
}

void ScriptEventDispatcher::UnitMoveFailed(const CUnit* unit) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::UnitMoveFailed, unit->id));
}

// === Feature events ===

void ScriptEventDispatcher::FeatureCreated(const CFeature* feature) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::FeatureCreated, feature->id));
}

void ScriptEventDispatcher::FeatureDestroyed(const CFeature* feature) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::FeatureDestroyed, feature->id));
}

void ScriptEventDispatcher::FeatureDamaged(
    const CFeature* feature, const CUnit* attacker,
    float damage, int weaponDefID, int projectileID)
{
    auto e = ScriptEvent::DamageEvent(
        feature->id,
        attacker ? attacker->id : 0,
        damage, weaponDefID, projectileID, false);
    e.type = ScriptEventType::FeatureDamaged;
    DispatchEvent(e);
}

// === Projectile events ===

void ScriptEventDispatcher::ProjectileCreated(const CProjectile* proj) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::ProjectileCreated, proj->id));
}

void ScriptEventDispatcher::ProjectileDestroyed(const CProjectile* proj) {
    DispatchEvent(ScriptEvent::UnitEvent(ScriptEventType::ProjectileDestroyed, proj->id));
}

// === Control events ===

bool ScriptEventDispatcher::AllowCommand(
    const CUnit* unit, const Command& cmd,
    int playerNum, bool fromSynced, bool fromLua)
{
    ScriptEvent e;
    e.type = ScriptEventType::AllowCommand;
    e.entityId = unit->id;
    e.intData[0] = cmd.GetID();
    e.intData[1] = playerNum;
    e.intData[2] = fromSynced ? 1 : 0;
    e.intData[3] = fromLua ? 1 : 0;
    e.controlResult = true; // default: allow

    DispatchControlEvent(e);
    return e.controlResult;
}

bool ScriptEventDispatcher::Explosion(
    int weaponID, int projectileID,
    const float3& pos, const CUnit* owner)
{
    ScriptEvent e;
    e.type = ScriptEventType::Explosion;
    e.entityId = owner ? owner->id : 0;
    e.intData[0] = weaponID;
    e.intData[1] = projectileID;
    e.position = pos;
    e.controlResult = false; // default: don't suppress

    DispatchControlEvent(e);
    return e.controlResult;
}
