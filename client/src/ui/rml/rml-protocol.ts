/**
 * RML bridge contract (PLAN-rml.md §3) — the frozen message surface between the
 * worker-side `RmlUi` Lua proxy (rml-bridge.ts) and the main-thread DOM overlay
 * (rml-overlay.ts).
 *
 * RmlUi is a retained-mode HTML/CSS UI library Recoil embeds and exposes to Lua.
 * BAR's RML widgets run in the LuaUI worker; the real DOM lives on the main
 * thread. So `RmlUi.*` calls are recorded as ordered ops in the worker, batched
 * once per frame, and replayed against a real DOM overlay on main. No DOM types
 * cross the boundary — the worker holds only opaque integer handles it allocates
 * (contextId / documentId / elementId / dataModelId).
 *
 * Mirror the `game-worker-protocol.ts` style: discriminated unions on a string
 * `op`/`type`, structured-clone-friendly payloads only. This module is shared
 * (imported by both the worker and main threads) and intentionally has no
 * runtime behaviour.
 */

// ─── worker → main: a batch of DOM operations, in frame order ────────────────

export interface RmlOpsToMain {
    type: 'rml:ops';
    ops: RmlOp[];
}

/**
 * A single DOM operation. Handles (`ctx`/`doc`/`dm`/`elem`/`parent`/`child`) are
 * worker-allocated monotonic integers, unique per kind. Main binds each handle
 * to a real node/context/model on first mention and looks it up thereafter.
 */
export type RmlOp =
    // ── context lifecycle ──
    | { op: 'ctxCreate'; ctx: number; name: string }
    | { op: 'ctxRemove'; ctx: number }
    | { op: 'ctxDpRatio'; ctx: number; dpRatio: number }
    // ── document lifecycle (a doc belongs to a ctx) ──
    | { op: 'docLoad'; ctx: number; doc: number; rmlPath: string }   // main fetches + translates the .rml
    | { op: 'docShow'; doc: number }
    | { op: 'docHide'; doc: number }
    | { op: 'docClose'; doc: number }
    | { op: 'docReloadCss'; doc: number }
    // ── data model: main keeps the model table, re-evaluates {{bindings}} on set ──
    | { op: 'dmOpen'; ctx: number; dm: number; name: string; initial: Record<string, unknown> }
    | { op: 'dmRemove'; dm: number; name?: string }
    | { op: 'dmSet'; dm: number; key: string; value: unknown }       // scalar, or JSON-able table/array
    // ── element ops (elem handle resolved within its doc) ──
    | { op: 'elGetById'; doc: number; elem: number; id: string }     // main binds handle → node
    | { op: 'elCreate'; doc: number; elem: number; tag: string }     // detached node
    | { op: 'elAppend'; parent: number; child: number }
    | { op: 'elRemoveChild'; parent: number; child: number }
    | { op: 'elSetInnerRml'; elem: number; rml: string }             // translate inline + apply
    | { op: 'elSetClassName'; elem: number; className: string }
    | { op: 'elSetClass'; elem: number; name: string; on: boolean }
    | { op: 'elSetAttr'; elem: number; name: string; value: string } // incl. name='style' inline css (translate)
    | { op: 'elAddListener'; elem: number; doc: number; event: string } // main attaches native listener → rml:event
    // ── document-scoped resources ──
    | { op: 'fontFace'; path: string; fallback: boolean }
    | { op: 'cursorAlias'; cssName: string; engineCursor: string }
    // ── i18n translation dictionary (the `!!key` resolution source, §5.3) ──
    // BAR's i18n module feeds RmlUi the active locale's strings via
    // ClearTranslations()/AddTranslationString('!!'..key, value); main keeps the
    // map and resolves `!!key` text in RML documents against it.
    | { op: 'i18nClear' }
    | { op: 'i18nAdd'; key: string; value: string };

// ─── main → worker: a DOM event fired on a listened element ──────────────────

export interface RmlEventToWorker {
    type: 'rml:event';
    ctx: number;
    doc: number;
    elem: number;
    /** 'click' | 'mousedown' | … (native DOM event type). */
    event: string;
    // Minimal payload BAR reads; extend as needed.
    mouseX?: number;
    mouseY?: number;
    button?: number;
    params?: Record<string, unknown>;
}

// ─── main → worker: viewport / dp-ratio change (ViewResize) ──────────────────

export interface RmlResizeToWorker {
    type: 'rml:resize';
    viewW: number;
    viewH: number;
}
