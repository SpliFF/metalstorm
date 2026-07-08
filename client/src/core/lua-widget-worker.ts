/**
 * lua-widget-worker.ts — entry point for the game-processor worker.
 *
 * This file is intentionally thin: imports + self.onmessage dispatcher only.
 * The actual logic lives in:
 *   - game-processor.ts  — GP state, rendering, connection, camera, FX
 *   - lua-ui-host.ts     — LuaUI runtime, liveState, widget callins, defs
 *   - gp-context.ts      — shared mutable seam refs (connection, renderers…)
 *   - worker-vfs.ts      — VFS lookup, prefetch, Lua source constants
 *
 * The entry file must remain `core/lua-widget-worker.ts` — main.ts and
 * lua-widget-manager.ts both bundle it by that path (anchor:
 * `import GameWorker from './core/lua-widget-worker.ts?worker'`).
 *
 * Extracted as part of PLAN-refactor-p3.md WP2c.
 */

import type { WorkerInbound } from './game-worker-protocol.js';
import {
    gpInit, gpResize, gpShutdown, gpSetShift, gpTestDispatch,
    gpHandlePointerMove, gpHandlePointerDown, gpHandlePointerUp,
    gpHandleWheel, gpHandleKeyDown, gpHandleKeyUp, gpHandleBlur, gpHandlePointerLeave,
    gpHandleFocusWorld, gpHandleStartBuildPlacement, gpHandleCancelBuildPlacement,
    gpHandleCancelCommandMode,
} from './game-processor.js';
// PLAN-rml.md: DOM events + viewport changes route straight into the RmlUi
// bridge (no game-processor state needed).
import { rmlHandleEvent, rmlResize } from '../ui/rml/rml-bridge.js';
import type { RmlEventToWorker, RmlResizeToWorker } from '../ui/rml/rml-protocol.js';
import {
    liveState, unitDefMap, weaponDefMap,
    postToMain, postLog, republishDefGlobals,
    init, getRuntime, getBridge, setMusicStreamTime, seedStorageCache,
    sameIdSet, escapeLuaString, dispatchCommandsChanged, dispatchSelectionChanged,
    dispatchPlayerChanged, dispatchUnitFromFactory, dispatchUnitTaken, dispatchUnitGiven,
    dispatchUnitCreated, dispatchUnitCommand, dispatchUnitCmdDone,
    dispatchVisibleUnitAdded, dispatchVisibleUnitRemoved, dispatchDefaultCommand,
    dispatchCommandNotify, applyEntityStateToLiveState, removeUnitFromLiveState,
    getWidgetList, toggleWidget, enableWidget, disableWidget, shutdown,
    pauseFramesHost, resumeFramesHost,
    describeInboundMessage,
    handleStateUpdate, handleRosterUpdate, handleRulesParamUpdate,
    handleSendToUnsynced, handleIntelTransitions, handleStandingOrders,
    handleUnitCommandQueues,
    type MinimalUnitDefWire, type MinimalWeaponDefWire,
} from './lua-ui-host.js';
import type { ProjectileEntry } from './lua-spring-api.js';
import { clientSettings } from './client-settings.js';

// ── Message handler ────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerInbound>) => {
    const msg = e.data as Record<string, unknown>;
    // Debug-level trace of inbound messages (skip high-frequency
    // channels to avoid drowning real log entries: pointer movement,
    // per-frame stateUpdate from the main thread's mouseState/camera
    // tracker, gameInfo (frame/speed/wind ticking every frame), the
    // entityState snapshot stream, and the periodic losBitmap push).
    if (msg.type !== 'mousemove'
        && msg.type !== 'stateUpdate'
        && msg.type !== 'gameInfo'
        && msg.type !== 'entityState'
        && msg.type !== 'losBitmap') {
        postLog(1, `[LuaUI:main→worker] ${describeInboundMessage(msg)}`);
    }
    switch (msg.type) {
        case 'init':
            try {
                // Pre-load localStorage data into cache before init
                if (msg.storageData) {
                    seedStorageCache(msg.storageData as Record<string, string>);
                }
                await init(msg.canvas as OffscreenCanvas | null, msg.gameId as string, msg.lobbyUrl as string, msg.mapData as import('./lua-ui-host.js').MapDataTransfer, msg.soloWidget as string | undefined);
            } catch (err) {
                postLog(4, `Init failed: ${err}`);
                postToMain({ type: 'error', msg: String(err) });
            }
            break;

        // PLAN-game-worker.md GW4: game-processor messages. At c1 only the
        // Engine bootstrap + resize/shutdown are wired; connection, decoders,
        // input and the scene-state feed land in c2–c5.
        case 'gp:init':
            try {
                gpInit(msg as unknown as import('./game-worker-protocol.js').GpInitToWorker);
            } catch (err) {
                postLog(4, `gp:init failed: ${err}`);
                postToMain({ type: 'error', msg: String(err) });
            }
            break;

        case 'gp:resize':
            gpResize(msg.width as number, msg.height as number, msg.dpr as number);
            break;

        // GW4-c5b: interactive camera input forwarded by the main-thread
        // CameraInput. Routed per-view (multi-view); absent viewId ⇒ view 0.
        case 'gp:pointermove':
            gpHandlePointerMove(msg.x as number, msg.y as number, msg.buttons as number, msg.mods as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:pointerdown':
            gpHandlePointerDown(msg.x as number, msg.y as number, msg.button as number, msg.mods as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:pointerup':
            gpHandlePointerUp(msg.x as number, msg.y as number, msg.button as number, msg.mods as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:wheel':
            gpHandleWheel(msg.x as number, msg.y as number, msg.delta as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:keydown':
            gpHandleKeyDown(msg.code as string, msg.mods as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:keyup':
            gpHandleKeyUp(msg.code as string, msg.mods as number, (msg.viewId as number) ?? 0);
            break;

        case 'gp:pointerleave':
            gpHandlePointerLeave((msg.viewId as number) ?? 0);
            break;

        case 'gp:blur':
            gpHandleBlur((msg.viewId as number) ?? 0);
            break;

        // GW4-c5c-3: live clientSettings/gfx.* push from main. Routing through
        // clientSettings.set updates the worker's cache AND fires the subscribers
        // (scene-lighting's msaa/fxaa/bloom/shadow + the FX-gating block in
        // gpInit), so a quality toggle on main applies in the worker with no
        // per-key switch here.
        case 'gp:config':
            try { clientSettings.set(msg.key as string, msg.value as never); }
            catch (err) { postLog(2, `[gp] gp:config ${msg.key} failed: ${err}`); }
            break;

        // GW4-c5c-3: minimap left-click → re-centre the world camera.
        case 'gp:focusWorld':
            gpHandleFocusWorld(msg.x as number, msg.z as number, (msg.viewId as number) ?? 0);
            break;

        // PLAN-playable.md G3a: native BuildMenu (main) arms/cancels the
        // worker-side build placement (ghost + snap + order emission).
        case 'gp:startBuildPlacement':
            gpHandleStartBuildPlacement(msg.defId as number, {
                shift: !!msg.shift, ctrl: !!msg.ctrl });
            break;
        case 'gp:cancelBuildPlacement':
            gpHandleCancelBuildPlacement();
            break;
        case 'gp:cancelCommandMode':
            gpHandleCancelCommandMode();
            break;

        // PLAN-rml.md: native DOM events + viewport changes from the main-thread
        // RML overlay, dispatched into the worker-side RmlUi bridge.
        case 'rml:event':
            rmlHandleEvent(msg as unknown as RmlEventToWorker);
            break;

        case 'rml:resize':
            rmlResize(msg as unknown as RmlResizeToWorker);
            break;

        case 'gp:shutdown':
            gpShutdown();
            break;

        // GW8: window.test client-bound request → resolve against the
        // worker-resident camera/selection/renderer/connection, reply by id.
        case 'gp:test': {
            const id = msg.id as number;
            try {
                const value = await gpTestDispatch(String(msg.method), (msg.args ?? []) as unknown[]);
                postToMain({ type: 'gp:testResult', id, ok: true, value });
            } catch (err) {
                postToMain({ type: 'gp:testResult', id, ok: false, error: String(err) });
            }
            break;
        }

        case 'keypress':
            { const rt = getRuntime(); if (rt) {
                const consumed = rt.evalString(`
                    if widgetHandler and widgetHandler.KeyPress then
                        local ok, ret = pcall(widgetHandler.KeyPress, widgetHandler, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} }, false)
                        return ok and ret and "1" or "0"
                    end
                    return "0"
                `);
                postToMain({ type: 'inputConsumed', kind: 'keypress', consumed: consumed === '1' });
            } }
            break;

        case 'keyrelease':
            { const rt = getRuntime(); if (rt) {
                rt.doString(`
                    if widgetHandler and widgetHandler.KeyRelease then
                        pcall(widgetHandler.KeyRelease, widgetHandler, ${msg.keyCode}, { alt=${msg.alt}, ctrl=${msg.ctrl}, meta=${msg.meta}, shift=${msg.shift} })
                    end
                `, 'callin:KeyRelease');
            } }
            break;

        case 'mousepress':
            { const rt = getRuntime(); if (rt) {
                const consumedStr = rt.evalString(`
                    if widgetHandler and widgetHandler.MousePress then
                        local ok, ret = pcall(widgetHandler.MousePress, widgetHandler, ${msg.x}, ${msg.y}, ${msg.button})
                        return ok and ret and "1" or "0"
                    end
                    return "0"
                `);
                postToMain({ type: 'inputConsumed', kind: 'mousepress', consumed: consumedStr === '1' });
            } }
            break;

        case 'mouserelease':
            { const rt = getRuntime(); if (rt) {
                rt.doString(`
                    if widgetHandler and widgetHandler.MouseRelease then
                        pcall(widgetHandler.MouseRelease, widgetHandler, ${msg.x}, ${msg.y}, ${msg.button})
                    end
                `, 'callin:MouseRelease');
            } }
            break;

        case 'defaultCommandTarget': {
            const targetType = (msg.targetType === 'unit' || msg.targetType === 'feature')
                ? msg.targetType as 'unit' | 'feature'
                : null;
            const targetId = Number(msg.targetId as number | 0);
            const engineCmd = Number(msg.engineCmd as number | 0);
            const resolved = dispatchDefaultCommand(targetType, targetId, engineCmd);
            liveState.defaultCommand = {
                targetType,
                targetId,
                engineCmd,
                cmdId: resolved,
            };
            postToMain({
                type: 'defaultCommandResolved',
                targetType,
                targetId,
                engineCmd,
                cmdId: resolved,
            });
            break;
        }

        case 'commandNotify': {
            const requestId = Number(msg.requestId as number | 0);
            const cmdId = Number(msg.cmdId as number | 0);
            const params = Array.isArray(msg.params) ? (msg.params as number[]) : [];
            const options = Number(msg.options as number | 0);
            let consumed = false;
            try {
                consumed = dispatchCommandNotify(cmdId, params, options);
            } catch (err) {
                postLog(3, `[CommandNotify] dispatch error: ${err}`);
            }
            postToMain({ type: 'commandNotifyResult', requestId, consumed });
            break;
        }

        case 'mousewheel':
            { const rt = getRuntime(); if (rt) {
                rt.doString(`
                    if widgetHandler and widgetHandler.MouseWheel then
                        pcall(widgetHandler.MouseWheel, widgetHandler, ${msg.up}, ${msg.value})
                    end
                `, 'callin:MouseWheel');
            } }
            break;

        case 'mousemove':
            { const rt = getRuntime(); if (rt) {
                const above = rt.evalString(`
                    if widgetHandler then
                        if widgetHandler.MouseMove then
                            pcall(widgetHandler.MouseMove, widgetHandler, ${msg.x}, ${msg.y}, ${msg.dx}, ${msg.dy}, ${msg.button})
                        end
                        if widgetHandler.IsAbove then
                            local ok, ret = pcall(widgetHandler.IsAbove, widgetHandler, ${msg.x}, ${msg.y})
                            return ok and ret and "1" or "0"
                        end
                    end
                    return "0"
                `);
                postToMain({ type: 'uiHover', above: above === '1' });
            } }
            break;

        case 'getWidgetList':
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'toggleWidget':
            toggleWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'enableWidget':
            await enableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'disableWidget':
            disableWidget(String(msg.name ?? ''));
            postToMain({ type: 'widgetList', data: getWidgetList() });
            break;

        case 'resize':
            if (getBridge() && msg.width && msg.height) {
                getBridge()!.resizeCanvas(msg.width as number, msg.height as number);
            }
            break;

        case 'evalLua': {
            if (!getRuntime()) break;
            const evalResult = getRuntime()!.evalString(String(msg.code ?? ''));
            postToMain({ type: 'evalResult', result: String(evalResult ?? 'nil') });
            break;
        }

        case 'musicStreamTime':
            setMusicStreamTime(Number(msg.played ?? 0), Number(msg.duration ?? 0));
            break;

        case 'pauseFrames':
            pauseFramesHost();
            break;
        case 'resumeFrames':
            resumeFramesHost();
            break;

        case 'stateUpdate':
            handleStateUpdate(msg);
            break;

        case 'entityState': {
            // GW4-c6-1b: legacy main→worker path (unreachable in the gp worker —
            // entity state now arrives via the in-worker connection's
            // onEntityState callback). Kept delegating to the shared merge so
            // there's no duplicated synth logic.
            applyEntityStateToLiveState({
                baseFrame: 0,
                count: msg.count as number,
                fieldMask: 0,
                entityIds: msg.entityIds as Uint32Array | null,
                positionsX: msg.positionsX as Float32Array | null,
                positionsY: msg.positionsY as Float32Array | null,
                positionsZ: msg.positionsZ as Float32Array | null,
                headings: msg.headings as Uint16Array | null,
                health: msg.health as Uint16Array | null,
                defIds: msg.defIds as Uint16Array | null,
                teams: msg.teams as Uint8Array | null,
                stateBits: msg.stateBits as Uint8Array | null,
                losStates: msg.losStates as Uint8Array | null,
                buildProgress: msg.buildProgress as Uint8Array | null,
                pitch: null,
                roll: null,
            }, msg.isDelta as boolean);
            break;
        }

        case 'entityDestroy': {
            removeUnitFromLiveState(msg.entityId as number);
            break;
        }

        case 'entitySensorUpdate': {
            const id = msg.entityId as number;
            const sensorType = msg.sensorType as number;
            const radius = msg.radius as number;
            const SENSOR_NAMES = ['los', 'airLos', 'radar', 'sonar',
                                  'seismic', 'radarJammer', 'sonarJammer'];
            const name = SENSOR_NAMES[sensorType];
            if (!name) break;
            let m = liveState.sensorOverrides.get(id);
            if (!m) {
                m = new Map();
                liveState.sensorOverrides.set(id, m);
            }
            m.set(name, radius);
            break;
        }

        case 'sendToUnsynced':
            handleSendToUnsynced(msg);
            break;

        case 'intelTransitions':
            handleIntelTransitions(msg);
            break;

        case 'seismicPings': {
            if (!getRuntime()) break;
            const pings = msg.pings as Array<{
                x: number; y: number; z: number; strength: number; allyTeam: number;
            }> | undefined;
            if (!pings || pings.length === 0) break;
            const lines: string[] = [];
            for (const p of pings) {
                lines.push(`if widgetHandler and widgetHandler.UnitSeismicPing then pcall(widgetHandler.UnitSeismicPing, widgetHandler, ${p.x}, ${p.y}, ${p.z}, ${p.strength}, ${p.allyTeam}, 0, 0) end`);
            }
            getRuntime()!.doString(lines.join('\n'), 'callin:seismicPings');
            break;
        }

        case 'losBitmap': {
            const allyTeam = msg.allyTeam as number;
            const width    = msg.width    as number;
            const height   = msg.height   as number;
            const frame    = msg.frame    as number;
            const inLos    = msg.inLos    as Uint8Array;
            const inRadar  = msg.inRadar  as Uint8Array;
            const explored = msg.explored as Uint8Array;
            if (!inLos || !inRadar || !explored) break;
            liveState.losBitmaps.set(allyTeam, {
                width, height, frame, inLos, inRadar, explored,
            });
            break;
        }

        case 'unitCommandQueues':
            handleUnitCommandQueues(msg);
            break;

        case 'unitCmdDescs': {
            const updates = msg.units as Array<{
                unitId: number;
                cmds: Array<{
                    cmdId: number;
                    disabled: boolean;
                    name: string;
                    action: string;
                    texture: string;
                    tooltip: string;
                    type: number;
                    params: string[];
                    hidden: boolean;
                }>;
            }> | undefined;
            if (!updates) break;
            liveState.unitCmdDescs.clear();
            for (const u of updates) {
                liveState.unitCmdDescs.set(u.unitId, u.cmds.map(c => ({
                    cmdId:    c.cmdId,
                    disabled: c.disabled,
                    name:     c.name    ?? '',
                    action:   c.action  ?? '',
                    texture:  c.texture ?? '',
                    tooltip:  c.tooltip ?? '',
                    type:     c.type    ?? 0,
                    params:   c.params  ?? [],
                    hidden:   c.hidden  ?? false,
                })));
            }
            dispatchCommandsChanged();
            break;
        }

        case 'unitTransports': {
            const transports = msg.transports as Array<{
                transporterId: number; cargo: number[];
            }> | undefined;
            if (!transports) break;
            liveState.transportCargo.clear();
            liveState.transportCarrier.clear();
            for (const t of transports) {
                liveState.transportCargo.set(t.transporterId, [...t.cargo]);
                for (const cargoId of t.cargo) {
                    liveState.transportCarrier.set(cargoId, t.transporterId);
                }
            }
            break;
        }

        case 'unitSelfD': {
            const units = msg.units as Array<{
                unitId: number; secondsRemaining: number;
            }> | undefined;
            if (!units) break;
            liveState.selfDCountdown.clear();
            for (const u of units) {
                if (u.secondsRemaining > 0)
                    liveState.selfDCountdown.set(u.unitId, u.secondsRemaining);
            }
            break;
        }

        case 'unitStockpile': {
            const units = msg.units as Array<{
                unitId: number; ready: number; queued: number; buildPercent: number;
            }> | undefined;
            if (!units) break;
            liveState.stockpileState.clear();
            for (const u of units) {
                liveState.stockpileState.set(u.unitId, {
                    ready: u.ready, queued: u.queued, buildPercent: u.buildPercent,
                });
            }
            break;
        }

        case 'unitLifecycle': {
            const events = msg.events as Array<{
                kind: 'fromFactory' | 'taken' | 'given' | 'created';
                unitId: number; unitDefId: number; unitTeam: number;
                factoryId: number; factoryDefId: number; userOrders: boolean;
                oldTeam: number; newTeam: number;
                builderId: number;
            }> | undefined;
            if (!events || !getRuntime()) break;
            for (const e of events) {
                if (e.kind === 'fromFactory') {
                    dispatchUnitFromFactory(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.factoryId, e.factoryDefId, e.userOrders);
                } else if (e.kind === 'taken') {
                    dispatchUnitTaken(e.unitId, e.unitDefId, e.oldTeam, e.newTeam);
                } else if (e.kind === 'given') {
                    dispatchUnitGiven(e.unitId, e.unitDefId, e.oldTeam, e.newTeam);
                } else if (e.kind === 'created') {
                    liveState.pendingSynthCreated.delete(e.unitId);
                    if (!liveState.serverFiredUnitCreated.has(e.unitId)) {
                        liveState.serverFiredUnitCreated.add(e.unitId);
                        dispatchUnitCreated(
                            e.unitId, e.unitDefId, e.unitTeam, e.builderId);
                    }
                }
            }
            break;
        }

        case 'visibleUnits': {
            const added = msg.added as Array<{
                id: number; defId: number; team: number;
            }> | undefined;
            const removed = msg.removed as number[] | undefined;
            if (!getRuntime()) break;
            if (added) {
                for (const u of added) {
                    dispatchVisibleUnitAdded(u.id, u.defId, u.team);
                }
            }
            if (removed) {
                for (const id of removed) {
                    dispatchVisibleUnitRemoved(id);
                }
            }
            break;
        }

        case 'unitCommand': {
            const events = msg.events as Array<{
                kind: 'issued' | 'done';
                unitId: number; unitDefId: number; unitTeam: number;
                cmdId: number; params: number[]; options: number; tag: number;
                playerId: number; fromSynced: boolean; fromLua: boolean;
            }> | undefined;
            if (!events || !getRuntime()) break;
            for (const e of events) {
                if (e.kind === 'issued') {
                    dispatchUnitCommand(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.cmdId, e.params, e.options, e.tag,
                        e.playerId, e.fromSynced, e.fromLua);
                } else {
                    dispatchUnitCmdDone(
                        e.unitId, e.unitDefId, e.unitTeam,
                        e.cmdId, e.params, e.options, e.tag);
                }
            }
            break;
        }

        case 'unitArmored': {
            const units = msg.units as Array<{
                unitId: number; armored: boolean; armoredMultiple: number;
            }> | undefined;
            if (!units) break;
            liveState.armoredState.clear();
            for (const u of units) {
                liveState.armoredState.set(u.unitId, {
                    armored: u.armored, armoredMultiple: u.armoredMultiple,
                });
            }
            break;
        }

        case 'pathResponse': {
            const requestId = Number(msg.requestId as number | 0);
            const waypoints = Array.isArray(msg.waypoints)
                ? (msg.waypoints as Array<[number, number, number]>)
                    .map(w => [Number(w[0]), Number(w[1]), Number(w[2])] as [number, number, number])
                : [];
            const length = Number(msg.length ?? 0);
            if (requestId > 0) {
                liveState.pathResponses.set(requestId, { waypoints, length });
            }
            break;
        }

        case 'standingOrders':
            handleStandingOrders(msg);
            break;

        case 'unitDefsUpdate': {
            const defs = msg.defs as MinimalUnitDefWire[] | undefined;
            if (!defs) break;
            if (defs.length > 0) {
                const first = defs[0] as unknown as Record<string, unknown>;
                const keys = Object.keys(first).slice(0, 50).join(',');
                const cp = first.customParams as Record<string, string> | undefined;
                const cpStr = cp ? Object.keys(cp).slice(0, 5).join(',') : 'undef';
                postLog(2, `[debug] unitDefsUpdate first def keys=[${keys}] cp=[${cpStr}]`);
            }
            for (const d of defs) unitDefMap.set(d.defId, d);
            { const rt2 = getRuntime(); if (rt2) republishDefGlobals(rt2); }
            break;
        }

        case 'projectileState': {
            const projs = msg.projectiles as ReadonlyArray<ProjectileEntry & { id: number }> | undefined;
            const next = new Map<number, ProjectileEntry>();
            if (projs) {
                for (const p of projs) {
                    next.set(p.id, {
                        defId: p.defId,
                        x: p.x, y: p.y, z: p.z,
                        vx: p.vx, vy: p.vy, vz: p.vz,
                        ttl: p.ttl, isBeam: p.isBeam,
                    });
                }
            }
            liveState.projectiles = next;
            break;
        }

        case 'weaponDefsUpdate': {
            const defs = msg.defs as MinimalWeaponDefWire[] | undefined;
            if (!defs) break;
            for (const d of defs) weaponDefMap.set(d.defId, d);
            { const rt3 = getRuntime(); if (rt3) republishDefGlobals(rt3); }
            break;
        }

        case 'rosterUpdate':
            handleRosterUpdate(msg);
            break;

        case 'rulesParamUpdate':
            handleRulesParamUpdate(msg);
            break;

        case 'resourceUpdate':
            liveState.resources.set(msg.team as number, {
                metal: msg.metal as number,
                maxMetal: msg.maxMetal as number,
                energy: msg.energy as number,
                maxEnergy: msg.maxEnergy as number,
                metalIncome: msg.metalIncome as number,
                energyIncome: msg.energyIncome as number,
                metalPull: (msg.metalPull as number) ?? 0,
                energyPull: (msg.energyPull as number) ?? 0,
                metalExpense: (msg.metalExpense as number) ?? 0,
                energyExpense: (msg.energyExpense as number) ?? 0,
                metalShare: (msg.metalShare as number) ?? 0,
                energyShare: (msg.energyShare as number) ?? 0,
                metalSent: (msg.metalSent as number) ?? 0,
                energySent: (msg.energySent as number) ?? 0,
                metalReceived: (msg.metalReceived as number) ?? 0,
                energyReceived: (msg.energyReceived as number) ?? 0,
                metalExcess: (msg.metalExcess as number) ?? 0,
                energyExcess: (msg.energyExcess as number) ?? 0,
            });
            break;

        case 'gameInfo':
            if (msg.frame !== undefined) liveState.gameFrame = msg.frame as number;
            if (msg.speed !== undefined) liveState.gameSpeed = msg.speed as number;
            if (msg.paused !== undefined) liveState.gamePaused = msg.paused as boolean;
            if (msg.gameOver !== undefined) liveState.gameOver = msg.gameOver as boolean;
            if (msg.wind) liveState.wind = msg.wind as typeof liveState.wind;
            if (msg.legacyCoordSystem !== undefined) {
                liveState.legacyCoordSystem = msg.legacyCoordSystem as boolean;
                getBridge()?.setLegacyCoordSystem(msg.legacyCoordSystem as boolean);
            }
            // The engine's unit/feature ID-space boundary (unitHandler.MaxUnits());
            // feeds Game.maxUnits. Guard > 0 so a not-yet-known 0 can't clobber
            // a good value already set via the worker connection path. See PLAN-bar.md.
            if (typeof msg.maxUnits === 'number' && msg.maxUnits > 0) {
                liveState.maxUnits = msg.maxUnits;
            }
            break;

        case 'mapFeatures': {
            const feats = msg.features as Array<{ id: number; x: number; y: number; z: number; defId: number; team: number; healthRatio: number }>;
            liveState.features.clear();
            for (const f of feats) {
                liveState.features.set(f.id, {
                    x: f.x, y: f.y, z: f.z,
                    defId: f.defId, team: f.team, healthRatio: f.healthRatio,
                });
            }
            break;
        }

        case 'shutdown':
            shutdown();
            break;
    }
};
