# PLAN-events.md — Removed Events Catalogue

This document catalogues every event, notification, and side-effect that was removed during Phase 0 cleanup. These were rendering callbacks, AI hooks, sound triggers, network sends, visual particle spawns, and Lua API functions that will need to be recreated in the new client-server architecture — either as server→client WebSocket messages, client-side rendering, or new server-side AI hooks.

Each entry records the original file, function context, call signature, and purpose so we can recreate them in the correct context during later phases.

---

## 1. AI Event Hooks (`eoh->`)

These were the ExternalAI C ABI hooks. The corresponding `eventHandler.*` Lua call-ins were **preserved** except where noted. In Phase 4 (AI), these need to be re-wired to the new server-side AI VM system.

### Unit Lifecycle

| Event | Signature | File / Context | Notes |
|---|---|---|---|
| UnitCreated | `eoh->UnitCreated(const CUnit& unit, const CUnit* builder)` | `Unit.cpp` `CUnit::PostInit` | builder is null for pre-placed units |
| UnitFinished | `eoh->UnitFinished(const CUnit& unit)` | `Unit.cpp` `CUnit::FinishedBuilding` | Fires when build progress reaches 100% |
| UnitDestroyed | `eoh->UnitDestroyed(const CUnit& unit, const CUnit* attacker)` | `Unit.cpp` `CUnit::ForcedKillUnit` | Pre-destruction; attacker null for self-destruct/reclaim |
| UnitCaptured | `eoh->UnitCaptured(const CUnit& unit, int oldTeam, int newTeam)` | `Unit.cpp` `CUnit::ChangeTeam` | Fires after team change, before quad re-insert |
| UnitGiven | `eoh->UnitGiven(const CUnit& unit, int oldTeam, int newTeam)` | `Unit.cpp` `CUnit::ChangeTeam` | Fires after full re-insertion into new team |

### Visibility

| Event | Signature | File / Context | Notes |
|---|---|---|---|
| UnitEnteredLos | `eoh->UnitEnteredLos(const CUnit& unit, int allyTeam)` | `Unit.cpp` `CUnit::SetLosStatus` | LOS bit transition: not-in-LOS → in-LOS |
| UnitLeftLos | `eoh->UnitLeftLos(const CUnit& unit, int allyTeam)` | `Unit.cpp` `CUnit::SetLosStatus` | losStatus cleared before event fires |
| UnitEnteredRadar | `eoh->UnitEnteredRadar(const CUnit& unit, int allyTeam)` | `Unit.cpp` `CUnit::SetLosStatus` | Radar ping appears |
| UnitLeftRadar | `eoh->UnitLeftRadar(const CUnit& unit, int allyTeam)` | `Unit.cpp` `CUnit::SetLosStatus` | losStatus cleared before event fires |

### Combat

| Event | Signature | File / Context | Notes |
|---|---|---|---|
| UnitDamaged | `eoh->UnitDamaged(const CUnit& unit, const CUnit* attacker, float damage, int weaponDefID, int projectileID, bool isParalyzer)` | `Unit.cpp` `CUnit::DoDamage` | **No surviving eventHandler equivalent at this callsite** — must be re-wired from scratch |
| WeaponFired | `eoh->WeaponFired(const CUnit& unit, const WeaponDef& weaponDef)` | `CommandAI.cpp` `CCommandAI::WeaponFired` | **No surviving eventHandler equivalent** — must be re-wired |
| SeismicPing | `eoh->SeismicPing(int allyTeam, const CUnit& unit, const float3& pos, float pingSize)` | `Unit.cpp` `CUnit::DoSeismicPing` | Fires per allyTeam; pos has per-team error |

### Movement & Commands

| Event | Signature | File / Context | Notes |
|---|---|---|---|
| UnitMoveFailed | `eoh->UnitMoveFailed(const CUnit& unit)` | `GroundMoveType.cpp` `CGroundMoveType::Fail` | Pathfinding fails to make progress |
| CommandFinished | `eoh->CommandFinished(const CUnit& unit, const Command& cmd)` | `CommandAI.cpp` `FinishCommand`, `ExecuteInsert`; `BuilderCAI.cpp` `ExecutePatrol`; `MobileCAI.cpp` `ExecutePatrol` | Patrol paths send synthetic CMD_PATROL completion |
| UnitIdle | `eoh->UnitIdle(const CUnit& unit)` | `CommandAI.cpp` `FinishCommand`, `GiveWaitCommand` | Only fired when `owner->GetGroup() == nullptr` |

### Lua Call-in (AI Channel)

| Event | Signature | File / Context | Notes |
|---|---|---|---|
| RecvSkirmishAIMessage | `const char* RecvSkirmishAIMessage(int aiID, const char* data, int inSize, size_t* outSize)` | `LuaHandle.cpp`, `LuaRules.h` | Bidirectional AI↔Lua message channel; registered in `Events.def` |

---

## 2. Sound Events

All sound was client-side only (gated by LOS/team checks). In Phase 3 (Audio), these become server→client combat/SFX events that the client plays via Web Audio API.

### Weapon & Combat Sounds

| Sound | Call | File / Context | Trigger |
|---|---|---|---|
| Weapon fire | `Channels::Battle->PlayRandomSample(weaponDef->fireSound, owner)` | `Weapon.cpp` `CWeapon::Fire` | Per-salvo or per-shot depending on `weaponDef->soundTrigger` |
| Explosion hit | `Channels::Battle->PlaySample(soundID, params.pos, soundSet.getVolume(soundNum))` | `GameHelper.cpp` `CGameHelper::Explosion` | Index 0 for land/air, index 1 for water; from `weaponDef->hitSound` |

### Unit State Sounds

| Sound | Call | File / Context | Trigger |
|---|---|---|---|
| Move start | `Channels::General->PlayRandomSample(owner->unitDef->sounds.activate, owner)` | `GroundMoveType.cpp` `StartMoving` | Ground unit begins moving |
| Unit activate | `Channels::General->PlayRandomSample(unitDef->sounds.activate, this)` | `Unit.cpp` `CUnit::Activate` | Power-on, cloak off, factory online |
| Unit deactivate | `Channels::General->PlayRandomSample(unitDef->sounds.deactivate, this)` | `Unit.cpp` `CUnit::Deactivate` | Power-off, dormant |
| Builder construction | `Channels::General->PlayRandomSample(unitDef->sounds.build, pos)` | `Builder.cpp` `ScriptStartBuilding` | Builder begins constructing |
| Factory production | `Channels::General->PlayRandomSample(unitDef->sounds.build, buildPos)` | `Factory.cpp` `StartBuild` | Factory starts producing a unit |

### Script-Driven Sounds

| Sound | Call | File / Context | Trigger |
|---|---|---|---|
| COB PlayUnitSound | `Channels::UnitReply->PlaySample(cobFile->sounds[snr], unit->pos, unit->speed, attr)` | `CobInstance.cpp` `PlayUnitSound` | COB animation opcode (walk, turn, recoil) |
| COB PLAY_SOUND | `Channels::General->PlaySample(cobFile->sounds[p1], pos_or_global, volume)` | `UnitScript.cpp` `GetUnitVal` | COB script instruction; supports positional/global, LOS-gated per 7-case switch |

### Asset Loading

| What | Call | File / Context | Notes |
|---|---|---|---|
| COB sound table | `sound->GetSoundId(name)` | `CobFile.cpp` constructor | Populates `cobFile->sounds[]` from TA:K format (version 6) |
| Def sound resolver | `sound->GetSoundId(fileName)` | `CommonDefHandler.cpp` `LoadSoundFile` | Resolves all UnitDef/WeaponDef sound references; now returns 0 |
| Map EAX reverb | `EAXSfxProps` construction from map Lua `sound` table | `MapInfo.cpp` `ReadSound` | OpenAL EFX environmental preset for map |

---

## 3. Visual Effects / Particles

All particle spawning is client-side. In Phase 2/3, these become server→client events (combat events, state changes) that the client renders via WebGL.

### Standard Explosion (`CStdExplosionGenerator::Explosion`)

File: `ExplosionGenerator.cpp`. Trigger: any explosion without a custom CEG.

| Particle | Parameters | Category |
|---|---|---|
| `CHeatCloudProjectile` | size = 8+√damage/2, life = 7+damage×2.8 | explosion cloud |
| `CSmokeProjectile2` (×damage×0.6) | time = 40+√damage×15, size = √damage×4 | smoke plume |
| `CDirtProjectile` (ground, ×20 max) | dark brown, upward-biased | ground debris |
| `CDirtProjectile` (water surface, ×40 max) | white, upward | water splash |
| `CWreckProjectile` (damage≥20, ×damage×0.04+9) | random outward | debris chunks |
| `CBubbleProjectile` (underwater, ×damage×0.7) | random within radius, upward drift | underwater bubbles |
| `CWakeProjectile` (water surface, ×damage×0.5) | ring spread | water wake |
| `CExploSpikeProjectile` (radius>10, ×√damage+8) | outward normalized | explosion spikes |
| `CStandardGroundFlash` (radius>20, damage>6) | flashSize=max(radius,damage×2), ttl=8+√damage×0.8 | ground flash |
| `CSpherePartProjectile` (radius>40, damage>12) | 5+√damage×0.7 parts | shockwave sphere |

### Custom Explosion Generator (`CCustomExplosionGenerator`)

| Particle | Notes |
|---|---|
| `CStandardGroundFlash` | From `GroundFlashInfo` struct, all params Lua-configurable |
| 13 CEG-spawnable types removed from dispatch table | `CStandardGroundFlash`, `CSimpleGroundFlash`, `CBitmapMuzzleFlame`, `CDirtProjectile`, `CExploSpikeProjectile`, `CHeatCloudProjectile`, `CNanoProjectile`, `CSimpleParticleSystem`, `CSphereParticleSpawner`, `CSmokeProjectile`, `CSmokeProjectile2`, `CSpherePartSpawner`, `CTracerProjectile` |

### Projectile Trails

| Particle | File | Trigger | Parameters |
|---|---|---|---|
| `CSmokeTrailProjectile` | `MissileProjectile.cpp` | On collision + every 8 frames during flight | width 7.0, fade 0.6 |
| `CSmokeTrailProjectile` | `StarburstProjectile.cpp` | On collision + every SMOKE_INTERVAL frames | width 7.0, fade 0.7 |
| `CSmokeTrailProjectile` | `PieceProjectile.cpp` | On collision + every 8 frames (PF_Smoke && PF_NoCEGTrail) | width 14.0, fade 0.5 |
| `CBubbleProjectile` | `TorpedoProjectile.cpp` | Every 1–2 frames while underwater | size 1–3, alpha 0.3–0.6, life 40+rand×GAME_SPEED |

### Unit Script VFX (`CUnitScript::EmitAbsSFX`)

File: `UnitScript.cpp`. Trigger: COB/Lua SFX emission calls.

| SFX Type | Particle | Category |
|---|---|---|
| `SFX_WAKE` / `SFX_WAKE_2` | `CWakeProjectile` | ship wake |
| `SFX_REVERSE_WAKE` / `SFX_REVERSE_WAKE_2` | `CWakeProjectile` (reversed dir) | ship wake (reverse) |
| `SFX_BUBBLE` | `CBubbleProjectile` | submarine bubbles |
| `SFX_WHITE_SMOKE` | `CSmokeProjectile` (alpha 0.5) | damage smoke (white) |
| `SFX_BLACK_SMOKE` | `CSmokeProjectile` (alpha 0.6) | damage smoke (black) |
| `SFX_VTOL` | `CHeatCloudProjectile` (life 10–15, size 3–5) | VTOL exhaust |

### Unit Script Actions

| Action | Particle | File | Trigger |
|---|---|---|---|
| Explode piece | `CHeatCloudProjectile` (life 30, size 30) | `UnitScript.cpp` `Explode` | COB `explode` opcode, if `!(flags & PF_NoHeatCloud)` |
| Muzzle flash | `CMuzzleFlame` | `UnitScript.cpp` `ShowFlare` | COB `show-flare` opcode |

### Feature Particles

| Particle | File | Trigger | Condition |
|---|---|---|---|
| `CSmokeProjectile` | `Feature.cpp` `Update` | Every 4 frames while `smokeTime != 0` | pos.y ≥ 0 (land/surface) |
| `CBubbleProjectile` | `Feature.cpp` `Update` | Every 4 frames while `smokeTime != 0` | pos.y < 0 (submerged) |
| `CGeoThermSmokeProjectile` | `Feature.cpp` `EmitGeoSmoke` | Every sim tick | `def->geoThermal == true` |

### Other VFX

| What | File | Notes |
|---|---|---|
| Aircraft engine trail (`CSmokeProjectile`) | `AAirMoveType.cpp` | Every tick; size 5, alpha 0.2–0.4 |
| Constructor nanoparticles (`CNanoProjectile`, 2 overloads) | `ProjectileHandler.cpp` `AddNanoParticle` | Guarded by `showNanoSpray`; uses team/def color |
| Shield visual segments (`ShieldSegmentCollection`) | `PlasmaRepulser.cpp` | Billboard ring around plasma shield |
| Ground flashes (container) | `ProjectileHandler.cpp` | `groundFlashes` container + `AddGroundFlash` method |
| Geometric objects (`CGeoSquareProjectile`) | `GeometricObjects.cpp` | Debug/overlay line segments and splines |
| Cannon muzzle particles | `Cannon.cpp` | `CHeatCloudProjectile` + `CSmokeProjectile` in `FireImpl` |

### Removed Draw() Methods

These define how each projectile renders on the client. Needed for Phase 2 WebGL implementation.

| Class | File | Renders |
|---|---|---|
| `CBeamLaserProjectile` | `BeamLaserProjectile.cpp` | Textured beam ribbon (edge+core) + end caps + flare |
| `CBeamLaserProjectile::DrawOnMinimap` | same | Colored line startPos→targetPos |
| `CLargeBeamLaserProjectile` | `LargeBeamLaserProjectile.cpp` | Tiled scrolling beam ribbon + caps + flare |
| `CLargeBeamLaserProjectile::DrawOnMinimap` | same | Line segment |
| `CEmgProjectile` | `EmgProjectile.cpp` | Single billboard quad, color×intensity |
| `CExplosiveProjectile` | `ExplosiveProjectile.cpp` | Multi-stage billboard chain along dir |
| `CFireBallProjectile` | `FireBallProjectile.cpp` | Per-spark billboards + fire core quads |
| `CFlameProjectile` | `FlameProjectile.cpp` | Billboard, color from colorMap at curTime |
| `CLaserProjectile` | `LaserProjectile.cpp` | Short laser bolt ribbon |
| `CLightningProjectile` | `LightningProjectile.cpp` | Segmented billboard bolt |
| `CLightningProjectile::DrawOnMinimap` | same | Line on minimap |
| `CMissileProjectile` | `MissileProjectile.cpp` | Billboard sprite (rocket flare) |
| `CStarburstProjectile` | `StarburstProjectile.cpp` | Multi-part tracer trail + engine flare |
| `CTorpedoProjectile` | `TorpedoProjectile.cpp` | 3D geometric torpedo body (8 tri faces) |
| `CFireProjectile` | `FireProjectile.cpp` | Layered billboard quads (flash + smoke) |
| `CPieceProjectile` | `PieceProjectile.cpp` | Fire trail billboards along trail positions |
| `CPieceProjectile::DrawOnMinimap` | same | Red line pos→pos+speed |
| `CWeaponProjectile::DrawOnMinimap` | `WeaponProjectile.cpp` | Yellow line pos→pos+speed |
| `CProjectile::DrawOnMinimap` | `Projectile.cpp` | White-alpha line pos→pos+speed |
| `CFlareProjectile` | `FlareProjectile.cpp` | Flare billboard |

---

## 4. Network Sends

These were client→server messages in the old P2P model. In the new architecture, the server is authoritative — some of these become server→client WebSocket messages instead.

| What | Call | File / Context | Purpose |
|---|---|---|---|
| Team died | `clientNet->Send(CBaseNetProtocol::Get().SendTeamDied(playerNum, teamNum))` | `Team.cpp` `Died` | Notify server of team death |
| Path CPU usage | `clientNet->Send(CBaseNetProtocol::Get().SendCPUUsage(...))` | `PathEstimator.cpp` `CalculateBlockOffsets`, `EstimatePathCosts` | Loading progress encoded in CPUUsage message |
| Game data pack | `GameData::Pack()` → `PackPacket` with `NETMSG_GAMEDATA` | `GameData.cpp` | Serialized map/mod checksums, random seed, compressed setup text |

---

## 5. Lua API Changes

Functions that now return nil/empty/zero instead of real data. These need server-side equivalents or client-side implementation.

### Functions Returning Hardcoded Values

| Lua Function | Previous Return | Now Returns | Needs |
|---|---|---|---|
| `Spring.IsGameOver()` | `game->IsGameOver()` | `false` | Server-side game-over state |
| `Spring.GetGrass(x, z)` | Grass density from `grassDrawer` | `0` | Client-side grass system |
| `Spring.GetTeamLuaAI(teamID)` | Lua AI short name | `nil` | New AI system (Phase 4) |
| `Spring.GetAIInfo(teamID)` | 6-value tuple (id, name, host, shortName, version, options) | `nil` | New AI system (Phase 4) |
| `Spring.GetTeamInfo()` field 4 | `hasSkirmishAI: bool` | `false` | New AI system (Phase 4) |
| `Spring.GetPlayerInfo()` field 7 | `hasSkirmishAI: bool` | `false` | New AI system (Phase 4) |
| `Spring.GetAvailableAIs()` | List of AI library keys | empty table | New AI system (Phase 4) |

### Draw Call-ins Receiving Zeroed Data

| Call-in | Affected Args | Notes |
|---|---|---|
| `ViewResize(viewInfo)` | All 8 numeric fields zeroed | Client will own screen dimensions |
| `DrawScreen(vsx, vsy)` | `0, 0` | Client-side only |
| `DrawInMiniMap(sx, sy)` | `0, 0` | Client-side only |
| `DrawUnit/Feature/Shield/Projectile/Material(id, drawMode)` | drawMode always `0` | Client-side draw mode |
| `KeyPress/KeyRelease` | Modifier bools all `false`, key string empty | Client-side input |
| `MousePress/Release/Move` | Raw coords (not viewport-relative) | Client-side input |

### Removed Lua API Functionality

| Function | What was removed | Notes |
|---|---|---|
| `Spring.GameOver(winningAllyTeams)` | `game->GameEnd()` call | Only `eventHandler.GameOver()` fires; needs server-side game-end |
| `Spring.AddObjectDecal(unitID)` | `groundDecals->AddSolidObject()` | Client-side decals |
| `Spring.RemoveObjectDecal(unitID)` | `groundDecals->ForceRemoveSolidObject()` | Client-side decals |
| `Spring.AddGrass(x, z)` | `grassDrawer->AddGrass()` | Client-side grass |
| `Spring.RemoveGrass(x, z)` | `grassDrawer->RemoveGrass()` | Client-side grass |
| `Spring.Render.*` table | Entire `LuaRender::PushEntries` | Client-side rendering API |
| `RecvSkirmishAIMessage` call-in | Bidirectional AI↔Lua channel | New AI system (Phase 4) |
| `SyncedPlayerChanged` event | Synced-only PlayerChanged variant | Merged into `PlayerChanged` |

---

## 6. Game Object Access Removed

Global objects that were removed and whose functionality needs replacement.

| Object | What it provided | Where used | Replacement needed |
|---|---|---|---|
| `game->` (CGame) | `IsGameOver()`, `playing`, `noSpectatorChat`, `ReloadCOB()`, `StartSkip()`/`EndSkip()`, `GetDrawMode()` | SyncedGameCommands, LuaSyncedRead, LuaSyncedCtrl, LuaHandleSynced | Server-side game state management |
| `selectedUnitsHandler` | `PossibleCommandChange()`, `ClearSelected()`, `ClearNetSelect()`, `netSelected[]` | CommandAI (5 files), Player.cpp, PlayerHandler.cpp, SyncedGameCommands, GroundMoveType | Client-side selection; server needs command validation only |
| `inMapDrawer` | `GetSpecMapDrawingAllowed()`/`SetSpecMapDrawingAllowed()` | SyncedGameCommands | Server config for spectator drawing permissions |
| `camera` | Position, direction, frustum | LuaSyncedRead, GroundMoveType, SMFReadMap | Client-side; server uses viewports |
| `globalRendering` | Screen dimensions, `drawDebugTraceRay` | LuaHandle, MapInfo, MapGenerator, TraceRay helpers | Client-side |
| `fpsController` | `SetControlleeUnit()`, `GetControllee()` | Player.cpp, Weapon.cpp | Server command for direct unit control |
| `grassDrawer` | `AddGrass()`, `RemoveGrass()`, density | LuaSyncedCtrl, BasicMapDamage, LuaSyncedRead | Client-side |
| `modelLoader` | `LoadModel()`, `FindModelPath()` | LuaSyncedCtrl, LuaUtils, SolidObjectDef, WorldObject | Assimp-based loading; models sent to clients |
| `loadscreen` | `SetLoadMessage()` | PathEstimator, PathManager, ReadMap, SMFReadMap | Server logging; client loading UI |

---

## 7. Additional Removals (Phase 0 build integration)

These events were removed during the build integration pass (commits after the initial PLAN-events.md creation) when integrating all 248 source files into the CMake build.

### Sound

| Sound | Call | File / Context | Trigger |
|---|---|---|---|
| Unit arrived | `Channels::General->PlayRandomSample(owner->unitDef->sounds.arrived, owner)` | `GroundMoveType.cpp` `Arrived()` | Unit finishes a move order. Gated on `owner->team == gu->myTeam`. |

### Player Input (FPS Direct Unit Control)

The entire FPS direct-control system was removed across multiple files. In the new architecture, direct unit control (if reimplemented) would be a server command with client-side camera managed independently.

| What | File / Context | Details |
|---|---|---|
| Ground unit FPS control | `GroundMoveType.cpp` `UpdateDirectControl()` | Read `fpsController.forward/back/left/right`, moved unit and rotated `camera->SetRotY()`. Now returns `false`. |
| Hover aircraft FPS control | `HoverAirMoveType.cpp` `Update()` | Read `fpsCon.forward/back/left/right/viewDir`, built `wantedSpeed`, called `UpdateAirPhysics()`. Entire block removed. |
| Strafe aircraft FPS control | `StrafeAirMoveType.cpp` `Update()` | Read `fpsCon.forward/back/left/right/elevator/aileron`, called `UpdateAirPhysics()`. Entire block removed. |
| Weapon fire gate | `Weapon.cpp` `AllowWeaponTargetCheck()` | `fpsPlayer->fpsController.mouse1/mouse2` check — suppressed weapon fire unless mouse button held in FPS mode. Removed. |
| Player FPS tick | `Player.cpp` `GameFrame()` | `fpsController.Update()` — per-frame input polling. Removed. |
| Start/Stop controlling | `Player.cpp` `StartControllingUnit()`/`StopControllingUnit()` | `selectedUnitsHandler.netSelected`, `eventHandler.AllowDirectUnitControl()`, `fpsControlPlayer`, mouse lock/unlock, camera push/pop. All removed. |
| Player handlers | `PlayerHandler.cpp` `LoadFromSetup()`/`AddPlayer()` | `fpsController.SetControllerPlayer(player)` — initialised FPS controller per player. Removed. |

### Rendering / Model System

| What | File / Context | Details |
|---|---|---|
| `SlowUpdateLocalModel()` | `UnitHandler.cpp` `SlowUpdateUnits()` | Called per-unit on slow tick to update render model bounding volumes. Removed. |
| `drawPos` interpolation | `Unit.cpp` `GetTransformMatrix()` | `synced ? pos : drawPos` — client-side interpolated position for smooth rendering. Now always uses `pos`. |
| Projectile model loading | `WeaponProjectile.cpp` constructor + `PostLoad()` | `model = params.model` / `model = weaponDef->LoadModel()` — assigned render mesh to projectiles. Removed. |
| Projectile `castShadow` | `MissileProjectile.cpp`, `StarburstProjectile.cpp` etc. | `castShadow = true` — shadow casting flag. Removed (member deleted from Projectile.h). |
| `SetLastHitPiece()` | `BeamLaser.cpp`, `LightningCannon.cpp`, `GameHelper.cpp` | Recorded which model piece was struck by a weapon for hit-spark placement and Lua `GetLastHitPiece()`. Removed. |
| `AddFlyingPiece()` | `ProjectileHandler.h` | Spawned debris mesh pieces on unit destruction. Declaration removed. |
| `AddNanoParticle()` (2 overloads) | `ProjectileHandler.h` | Spawned construction nanoparticle spray. Declaration removed. |

### VFX / Particles

| What | File / Context | Details |
|---|---|---|
| Shield repulse glow | `PlasmaRepulser.cpp` `IncomingProjectile()` | `projMemPool.alloc<CRepulseGfx>(...)` — visual glow when shield deflects a projectile. Gated on `weaponDef->visibleShieldRepulse`. |
| Seismic ground flash | `Unit.cpp` `DoSeismicPing()` | `projMemPool.alloc<CSeismicGroundFlash>(pingPos, ...)` — visual ping when unit in seismic range but not LOS. |
| Heightmap update notification | `ReadMap.cpp` `UpdateDraw()` | `eventHandler.UnsyncedHeightMapUpdate(rect)` — notified unsynced Lua about terrain deformation for visual update. |
| Wait command icons | `WaitCommandsAI.cpp` `DrawCommands()` | Iterated `waitMap`, called `Draw()` per wait object, drew command icons via `lineDrawer.DrawIconAtLastPos()` and `cursorIcons.AddIconText()`. |

### Lua API — Rendering / Draw Callins

| What | File / Context | Details |
|---|---|---|
| `DRAW_CALLIN` dispatch | `EventHandler.cpp` | All `Draw*` event dispatchers (DrawGenesis, DrawWater, DrawGround, DrawUnits, DrawHUD, DrawScreen, DrawInMiniMap, etc.) — `LuaOpenGL::EnableDraw`, iteration, `LuaOpenGL::DisableDraw`. Now no-ops. |
| GL matrix state guard | `LuaHandle.cpp` `RunCallInTraceback()` | `LuaOpenGL::IsDrawingEnabled()`, `matTracker.PushMatrixState()`/`PopMatrixState()`, `InitMatrixState()`/`CheckMatrixState()`. Removed. |
| `Spring.UnitRendering` / `Spring.FeatureRendering` | `LuaRules.cpp` `AddUnsyncedCode()` | `LuaObjectRendering<LUAOBJ_UNIT/FEATURE>::PushEntries(L)` — per-object rendering override API. Removed. |
| `Spring.Render.*` table | `LuaHandleSynced.cpp` `Init()` | `LuaRender::PushEntries` — entire Spring.Render Lua API namespace. Removed (in prior commit). |
| `LuaUI->ShockFront` | `GameHelper.cpp` `Explosion()` | `luaUI->ShockFront(pos, cameraShake, damageAOE)` — camera shake notification to LuaUI on explosions with `weaponDef->cameraShake > 0`. |
| `CLuaUI::UpdateTeams` | `Player.cpp`, `SyncedGameCommands.cpp` | Called on spectate, team join, and god mode toggle to rebuild team UI state in LuaUI. |

### Lua API — Synced Read/Write

| Function | What was removed | Notes |
|---|---|---|
| `Spring.GetLastHitPiece(unitID)` | Read `hitModelPieces[true]`, `pieceHitFrames[true]` | Returns piece name/index and frame of last hit. Stubbed to return 0. |
| `Spring.GetPlayerControlledUnit(playerID)` | Read `fpsController.GetControllee()` | Returns unit ID of FPS-controlled unit. Stubbed to return 0. |
| `Spring.SetNoPause(bool)` | `gameServer->SetGamePausable(!val)` | Forwarded to in-process GameServer. Stubbed; needs network re-routing in Phase 1. |
| `Spring.SpawnProjectile({model=...})` | `modelLoader.LoadModel(name)` | Lua could set custom model on spawned projectile. Now always `nullptr`. |
| `Spring.SetUnitPieceParent(...)` | `LocalModel::GetRoot()`, `piece->parent/SetParent/AddChild` | Model hierarchy manipulation. Stubbed to return 0. |
| `Spring.SetUnitPieceMatrix(...)` | `piece->SetPieceSpaceMatrix/SetDirty/blockScriptAnims` | Per-piece transform override. Stubbed to return 0. |

### Lua API — Callin Data Degradation

These callins still fire but now receive zeroed/empty data instead of real values:

| Callin | Degraded Args | Original Source |
|---|---|---|
| `ViewResize(viewInfo)` | All 8 numeric fields zeroed | `globalRendering->screenSizeX/Y`, `winSizeX/Y`, `viewSizeX/Y`, `viewPosX/Y` |
| `DrawScreen(vsx, vsy)` | `0, 0` | `globalRendering->viewSizeX/Y` |
| `DrawInMiniMap(sx, sy)` | `0, 0` | `minimap->GetSizeX()/GetSizeY()` |
| `DrawUnit/Feature/Shield/Projectile/Material(id, drawMode)` | drawMode `0` | `game->GetDrawMode()` |
| `KeyPress/KeyRelease(key, mods, ...)` | All modifier bools `false`, key string `""` | `KeyInput::GetKeyModState()`, `CKeySet::GetString()`, SDL keysyms |
| `MousePress/Release/Move(x, y, ...)` | Raw coords (not viewport-relative, not Y-flipped) | `x - viewPosX`, `viewSizeY - y - 1` |

### Game State / Commands

| What | File / Context | Details |
|---|---|---|
| `/nospecdraw` command | `SyncedGameCommands.cpp` | Entire `NoSpecDrawActionExecutor` class removed. Toggled `inMapDrawer->GetSpecMapDrawingAllowed()`. |
| `/nospectatorChat` command | `SyncedGameCommands.cpp` | `game->noSpectatorChat` toggle removed. Stubbed with LOG. |
| `/reloadcob` command | `SyncedGameCommands.cpp` | `game->ReloadCOB()` call removed. Stubbed with LOG. |
| `/skip` command | `SyncedGameCommands.cpp` | `game->StartSkip()`/`EndSkip()` removed. Stubbed with LOG. |
| `NoHelperAI` notification | `SyncedGameCommands.cpp` | `selectedUnitsHandler.PossibleCommandChange(nullptr)` — notified AI/UI of command availability change. |

### Network / Serialization

| What | File / Context | Details |
|---|---|---|
| `CLIENT_NETLOG` desync trace | `LuaHandle.cpp` `RunCallInTraceback()` | Sent Lua error traceback to server on synced Lua runtime error for desync diagnosis. |
| `GameData::Pack()` | `GameData.cpp` | Serialized game data to `PackPacket` with `NETMSG_GAMEDATA`. Removed. |
| `Command::Serialize()` | `Command.cpp` | creg serialization of command params. Removed (creg gone). |
| `CLuaUnitScript::Serialize()` | `LuaUnitScript.cpp` | creg serialization of Lua script state. Removed. |
| `CPlasmaRepulser::SerializeShieldSegmentCollectionPool()` | `PlasmaRepulser.h` | creg serialization of shield visual pool. Removed. |
| `CExpGenSpawner::Serialize()` | `ExpGenSpawner.cpp` | creg serialization of explosion generator spawner. Removed. |

### Archive / VFS Queries

All archive/VFS query APIs are stubbed to return empty results. The server reads content from plain directories (PLAN-content.md).

| What | Where Used | Details |
|---|---|---|
| `archiveScanner->GetMaps/GetPrimaryMods/GetAllArchives/GetArchiveData/etc.` | `LuaArchive.cpp`, `ModInfo.cpp`, `ExplosionGenerator.cpp`, `PathManager.cpp` | All return empty results. |
| `vfsHandler->GetAllArchiveNames/AddArchive/etc.` | `LuaVFS.cpp`, `LuaArchive.cpp`, `LuaGaia.cpp` | All return empty/false. |
| `sha512::calc_digest/dump_digest` | `PathManager.cpp`, `LuaArchive.cpp`, `Misc.cpp` | Content integrity checksums removed (no P2P sync). |
| `GetRapidPackageFromTag()` | `StartScriptGen.cpp`, `LuaArchive.cpp` | Rapid content delivery removed. Returns `""`. |

---

## 8. Client-Side Event Propagation — HTML/JS ↔ Wasmoon (Lua WASM)

This section covers how events flow between the browser environment (HTML UI, DOM events, WebSocket messages) and the Wasmoon Lua runtime that executes client-side widgets. It replaces Spring's original model where Lua widgets ran inside the same process as the game and could call `gl.*` functions synchronously.

### Architecture Overview

```
                     ┌─────────────────────────────────────┐
                     │           Browser Environment       │
                     │                                     │
  ┌──────────┐       │   ┌───────────┐    ┌────────────┐   │
  │ HTML UI  │───────┼──▶│ InputMgr  │───▶│ WidgetMgr  │   │
  │ (DOM)    │       │   └───────────┘    │            │   │
  └──────────┘       │         ▲          │  ┌───────┐ │   │
                     │         │          │  │JS     │ │   │
  ┌──────────┐       │   ┌─────┴─────┐   │  │Widgets│ │   │
  │ Canvas   │───────┼──▶│ Babylon.js│   │  └───────┘ │   │
  │ (WebGL)  │       │   └───────────┘   │  ┌───────┐ │   │
  └──────────┘       │                    │  │Lua    │ │   │
                     │   ┌───────────┐   │  │WASM   │ │   │
  ┌──────────┐       │   │ WebSocket │───▶│  │Widgets│ │   │
  │ Server   │───────┼──▶│ Connection│   │  └───────┘ │   │
  └──────────┘       │   └───────────┘   └────────────┘   │
                     │                          │          │
                     │                    ┌─────▼──────┐   │
                     │                    │ Command    │   │
                     │                    │ Buffer     │   │
                     │                    │ Renderer   │   │
                     │                    └────────────┘   │
                     └─────────────────────────────────────┘
```

### Event Sources and Sinks

There are three sources of events that widgets (both JS and Lua WASM) can receive:

**Source 1: Browser Input (DOM events)**
- Keyboard: `keydown`, `keyup` → normalised to `KeyPress(key, ctrl, alt, shift)`, `KeyRelease(key)`
- Mouse: `mousedown`, `mouseup`, `mousemove`, `wheel` → normalised to `MousePress(x, y, button)`, `MouseRelease(x, y, button)`, `MouseMove(x, y, dx, dy)`, `MouseWheel(delta)`
- Touch: mapped to mouse equivalents
- These originate from the canvas element. HTML UI elements above the canvas consume their own events via `pointer-events: auto`; only events that fall through to the canvas reach widgets.

**Source 2: Server Game State (WebSocket messages)**
- Entity state snapshots (envelope 0x02/0x03) → `EntityCreated(unitId)`, `EntityDestroyed(unitId)`, `EntityUpdated(unitId)`
- Combat events (GameEventBatch) → `UnitDamaged(unitId, attackerId, damage)`, `UnitKilled(unitId)`
- Game lifecycle → `GameFrame(frame)`, `GameStart()`, `GameOver(winners)`
- Chat → `ChatReceived(senderId, text, channel)`
- Room state → `RoomStateChanged(state)`, `RoomPlayerJoined(player)`

**Source 3: Engine Render Loop**
- `Update(dt)` — every render frame, for animation and continuous logic
- `DrawScreen(viewSizeX, viewSizeY)` — 2D overlay drawing pass (command buffer)
- `DrawWorld()` — 3D scene drawing pass (command buffer)

### Event Dispatch to Lua WASM Widgets

Events reach Lua widgets through the WidgetManager, which calls into the Wasmoon runtime:

```
1. Event arrives (DOM, WebSocket, or render tick)
        ↓
2. InputManager / Connection normalises it to a widget event
        ↓
3. WidgetManager.dispatch(eventName, ...args)
        ↓
4. For each active widget (in priority order):
   ├── JS widget: direct function call → widget.onKeyPress(key, ...)
   └── Lua WASM widget: cross-boundary call → wasmoon.callFunction(widgetRef, "KeyPress", key, ...)
        ↓
5. If widget returns true → event consumed, stop dispatching
   If widget returns false/nil → continue to next widget
```

**Important:** Lua WASM call-ins are synchronous within a single frame. The WidgetManager calls all widget handlers, collects return values, and the frame continues. There is no async queue between WidgetManager and Lua — the Wasmoon VM executes inline on the main thread.

### Input Event Chain with HTML Overlay

The critical design question is how mouse/keyboard events interact with HTML UI elements layered above the WebGL canvas.

```
Browser captures input event (click at screen position x, y)
        ↓
    Hit test: does the click land on an HTML element with pointer-events: auto?
    ├── YES: HTML element handles it (button, text input, panel scroll)
    │        → Canvas and widgets never see this event
    │        → No further propagation
    └── NO:  Event falls through to <canvas>
             ↓
         InputManager receives it
             ↓
         InputManager dispatches to WidgetManager
             ↓
         Widgets process in order:
         ├── Widget A: widget:MousePress(x, y, btn) → returns false (didn't handle)
         ├── Widget B: widget:MousePress(x, y, btn) → returns true (consumed!)
         │   → Stop dispatching to further widgets
         │   → InputManager marks event as consumed
         └── (or no widget consumed it)
             → InputManager handles as game input (select unit, issue command)
```

**HTML→Lua example:** A custom Lua widget draws a panel via `gl.Rect()` in `DrawScreen()`. The player clicks within that panel area. The click goes to the canvas (HTML sees nothing there — the panel is drawn in WebGL). The widget's `MousePress()` call-in checks if the click position is within its panel bounds and returns `true` to consume it.

**HTML button→Lua example:** A game ships a Svelte component for a build menu. The player clicks a build button. The HTML button's `onclick` handler fires, calls `scriptAPI.command(CMD.BUILD, ...)` or dispatches a custom event via `widgetManager.dispatch('BuildOrdered', defId)`. Lua widgets listening to `BuildOrdered` receive the event.

### The gl.* Command Buffer

Lua widgets draw UI via `gl.*` calls. These do NOT cross the JS-WASM boundary per call. Instead:

```
Lua code:                    Shared memory (WASM linear memory):
gl.Color(1, 0, 0, 1)    →   [OPCODE_COLOR, 1.0, 0.0, 0.0, 1.0]
gl.Rect(10, 20, 200, 50)→   [OPCODE_RECT, 10.0, 20.0, 200.0, 50.0]
gl.Text("HP: 50", x, y) →   [OPCODE_TEXT, x, y, strOffset, strLen]
                             ...buffer grows during DrawScreen()...

After widget:DrawScreen() returns:
    JS reads entire buffer (one copy)
    CommandBufferRenderer interprets opcodes
    Issues batched WebGL/Canvas2D calls
    Clears buffer for next frame
```

**Opcodes** (32-bit each, followed by typed parameters):

| Opcode | Parameters | WebGL Equivalent |
|--------|-----------|------------------|
| `COLOR` | r, g, b, a (4×f32) | Set current draw colour |
| `RECT` | x1, y1, x2, y2 (4×f32) | Draw filled rectangle |
| `RECT_OUTLINE` | x1, y1, x2, y2 (4×f32) | Draw rectangle outline |
| `TEXT` | x, y, strOffset, strLen (4×i32) | Render text at position |
| `TEXTURE` | texId (1×i32) | Bind texture for subsequent draws |
| `LINE` | x1, y1, x2, y2 (4×f32) | Draw line segment |
| `BEGIN_TRIANGLES` | — | Start triangle batch |
| `END` | — | End primitive batch |
| `VERTEX` | x, y (2×f32) | Add vertex to current batch |
| `TEX_COORD` | u, v (2×f32) | Set texture coordinate |
| `PUSH_MATRIX` | — | Save transform state |
| `POP_MATRIX` | — | Restore transform state |
| `TRANSLATE` | x, y (2×f32) | Translate coordinate system |
| `ROTATE` | angle (1×f32) | Rotate coordinate system |
| `SCALE` | sx, sy (2×f32) | Scale coordinate system |

The buffer is pre-allocated (e.g. 1MB) in WASM linear memory. The C stubs for `gl.*` functions write directly to this buffer with no JS call overhead. Overflow triggers a flush-and-continue.

### Game Events from Server to Widgets

Server game events arrive via WebSocket and are translated to widget call-ins:

| Server Message | Widget Call-in | Available to |
|---------------|---------------|--------------|
| EntityCreate (FlatBuffers) | `widget:UnitCreated(unitId, defId, team, x, y, z)` | JS + Lua |
| EntityDestroy (FlatBuffers) | `widget:UnitDestroyed(unitId)` | JS + Lua |
| Entity state (Tier 2 binary) | — (handled by EntityRenderer, not dispatched per-entity) | — |
| CombatEvent | `widget:UnitDamaged(unitId, attackerId, damage, weaponDefId)` | JS + Lua |
| CombatEvent (result=kill) | `widget:UnitKilled(unitId, attackerId)` | JS + Lua |
| GameEventBatch (generic) | `widget:GameEvent(topic, entityId, position, payload)` | JS + Lua |
| GameFrame (derived from entity state) | `widget:GameFrame(frameNum)` | JS + Lua |
| ChatReceive | `widget:ChatReceived(senderId, senderName, text, channel)` | JS + Lua |
| GameInfo | `widget:GameInfo(mapName, gameName, speed, paused)` | JS + Lua |

### Custom Events: HTML UI ↔ Widgets

Games need a way to send events between their HTML UI components and their Lua/JS widgets. This uses a simple named-event system:

**HTML → Widget (e.g. a build button in HTML triggers a Lua build-placement widget):**

```javascript
// In the HTML button's click handler:
widgetManager.dispatch('BuildButtonPressed', { defId: 42, defName: 'pt_heavytank' });
```

```lua
-- In the Lua widget:
function widget:BuildButtonPressed(data)
    self.placingBuilding = data.defId
    -- Start showing build placement ghost
end
```

**Widget → HTML (e.g. a Lua widget wants to show a tooltip in HTML):**

```lua
-- In the Lua widget:
Spring.SendUIEvent("ShowTooltip", { text = "Heavy Tank\nHP: 2500\nCost: 500M", x = mx, y = my })
```

```javascript
// In the HTML tooltip component:
widgetManager.onUIEvent('ShowTooltip', (data) => {
    tooltipEl.textContent = data.text;
    tooltipEl.style.left = data.x + 'px';
    tooltipEl.style.top = data.y + 'px';
    tooltipEl.style.display = 'block';
});
```

This bidirectional channel allows games to mix HTML UI (forms, styled panels, responsive layouts) with Lua widget logic (game-aware drawing, state tracking) without either side knowing about the other's implementation.

### Event Ownership and Consumption

When multiple handlers exist for the same event, processing follows this priority chain:

```
1. HTML UI (highest priority — if an element has pointer-events: auto, it wins)
2. Lua widgets (in widget order, first to return true consumes)
3. JS widgets (in widget order, first to return true consumes)
4. Default engine handler (camera control, unit selection, command issue)
```

For non-input events (game state, chat), all handlers receive the event — there is no consumption. Only input events (mouse, keyboard) support the "return true to consume" pattern.

### Performance Budget

Per-frame budget for widget event dispatch:

| Phase | Target | Notes |
|-------|--------|-------|
| Input dispatch (all widgets) | < 0.5ms | ~10 events/frame typical |
| DrawScreen (all widgets) | < 2ms | Command buffer eliminates per-call overhead |
| DrawWorld (all widgets) | < 1ms | Most widgets don't use this |
| Game event dispatch | < 0.5ms | Batched per frame, not per event |
| Command buffer flush | < 1ms | Single buffer read + batched WebGL |
| **Total widget overhead** | **< 5ms** | **Leaves 11ms for rendering at 60fps** |

If a widget exceeds its time budget, the WidgetManager logs a warning and can auto-disable it after repeated overruns (configurable threshold, e.g. 3 consecutive frames > 10ms).
