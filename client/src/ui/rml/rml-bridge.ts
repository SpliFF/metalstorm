/**
 * rml-bridge.ts — the worker-side `RmlUi` Lua global (PLAN-rml.md §4).
 *
 * Recoil injects an `RmlUi` global into the LuaUI environment, backed by its
 * embedded C++ RmlUi library. We have no RmlUi engine in the worker — the real
 * DOM lives on the main thread (rml-overlay.ts). So this module installs an
 * `RmlUi` global whose Context / Document / Element / DataModel objects are
 * thin Lua proxies (defined in rml-lua.ts): every mutating call records an
 * ordered `RmlOp` into a worker-side queue, flushed once per frame
 * (`rmlFlush`, at the tail of `gpRunUiPass`) as a single `rml:ops` message.
 * Reads are answered from a worker-side mirror so they never round-trip.
 *
 * This module is the JS orchestrator: it owns the op queue, the single
 * `__rmlRecordOp` JS sink, event/resize dispatch back into Lua, and teardown.
 * The proxy machinery itself lives in rml-lua.ts.
 */

import type { LuaRuntime } from '../../core/lua-runtime.js';
import { postToMain, postLog } from '../../core/lua-ui-host.js';
import type { RmlOp, RmlEventToWorker, RmlResizeToWorker } from './rml-protocol.js';
import { RML_LUA } from './rml-lua.js';

/// Ordered op queue for the current frame. Recorded by the Lua proxies via
/// `__rmlRecordOp`, drained by `rmlFlush()` once per frame. Never flush
/// per-call — a TD leaderboard rebuild records dozens of ops per frame and one
/// postMessage each would be catastrophic (PLAN-rml.md §1.2).
let opQueue: RmlOp[] = [];

/// The runtime the global was installed into, so `rmlHandleEvent` can dispatch
/// back into Lua. Cleared on reset. One runtime per game session.
let rmlRuntime: LuaRuntime | null = null;

/**
 * Install the `RmlUi` global into the LuaUI runtime. Must run BEFORE the LuaUI
 * bootstrap loads the game's `rml_setup.lua` (which guards `if not RmlUi then
 * return end`) so RML widgets see a live global and initialise.
 */
export function installRmlGlobal(runtime: LuaRuntime): void {
    rmlRuntime = runtime;
    opQueue = [];

    // The single JS sink: receives a plain op table from Lua, pushes it to the
    // frame queue. The runtime's table walker converts the Lua op (including
    // nested `value`/`initial` tables/arrays) to a structured-clone-friendly
    // JS object, so no manual marshalling is needed here.
    runtime.setGlobal('__rmlRecordOp', (op: unknown) => {
        opQueue.push(op as RmlOp);
    });

    const err = runtime.doString(RML_LUA, 'rml_bridge');
    if (err) postLog(4, `[rml] installRmlGlobal failed: ${err}`);
    else postLog(2, '[rml] RmlUi global installed (DOM-overlay bridge)');
}

/** Flush the frame's recorded ops to the main-thread overlay. No-op if empty. */
export function rmlFlush(): void {
    if (opQueue.length === 0) return;
    const ops = opQueue;
    opQueue = [];
    postToMain({ type: 'rml:ops', ops });
}

/**
 * A native DOM event fired on a listened overlay element. Dispatch it to the
 * Lua listener registered via `element:AddEventListener`. Errors are logged,
 * never thrown into the frame loop.
 */
export function rmlHandleEvent(msg: RmlEventToWorker): void {
    if (!rmlRuntime) return;
    const payload: Record<string, unknown> = {
        mouseX: msg.mouseX ?? 0,
        mouseY: msg.mouseY ?? 0,
        button: msg.button ?? 0,
    };
    if (msg.params) payload.params = msg.params;
    rmlRuntime.callTableFn('RmlUi', '__dispatchEvent', msg.elem, msg.event, payload);
}

/**
 * Viewport / dp-ratio change (ViewResize). PLAN-rml.md §4.4: the bridge itself
 * does not compute dp_ratio — BAR's `rml_context_manager.lua:ViewResize`
 * recomputes it from `Spring.GetViewGeometry()` + `ui_scale`. So all this needs
 * to do is fire the `ViewResize` widget callin (which the worker already does on
 * `gp:resize`); the dp-ratio recompute + `--dp` propagation is wired in R4.
 * Kept as an explicit seam so the routing exists from R0.
 */
export function rmlResize(_msg: RmlResizeToWorker): void {
    // R4: trigger context-manager dp-ratio recompute. The gp:resize path
    // already fires widgetHandler:ViewResize, so nothing extra is required yet.
}

/** Drop all bridge state (game teardown). The Lua state is per-runtime and
 *  discarded with the runtime, so we only clear the JS-side queue + ref. */
export function rmlReset(): void {
    opQueue = [];
    rmlRuntime = null;
}
