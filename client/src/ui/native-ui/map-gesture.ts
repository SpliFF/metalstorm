/**
 * map-gesture.ts — main-thread bridge to the worker-side shared shape-
 * gesture capture (PLAN-macro-ui.md §2/§5, PLAN-metalstorm-scripting.md
 * task 4 "map-arm integration").
 *
 * `DirectiveShapeCapture` (game-processor.ts, in the worker) is armed
 * cross-thread via `gp:armDirectiveShape` / `gp:cancelDirectiveShape` and
 * reports back via `gp:directiveShapeArmed` / `gp:directiveShapeResult`
 * (game-worker-protocol.ts). This module is the main-thread half of that
 * surface for native JS widgets: a widget calls `mapGestureBridge.arm()`
 * with `captureOnly: true` implied (this bridge is capture-only by design —
 * a widget that wants the org-panel's "paint directive → auto-send" flow
 * arms the worker directly via its own postMessage, not through here) and
 * gets the drawn shape back through `onResult`, instead of an immediate
 * `GroupDirective` send.
 *
 * A singleton: only one capture can be armed at a time (the worker-side
 * capture owns the pointer exclusively while armed), so a shared instance
 * is simpler than per-widget wiring and matches `namedEntityIndex`'s
 * singleton convention.
 *
 * main.ts wires `setWorkerPost()` once the game-processor worker exists and
 * forwards `gp:directiveShapeArmed`/`gp:directiveShapeResult` messages into
 * `handleWorkerMessage()`.
 */

export type MapGestureShape = 'Point' | 'Circle' | 'Polygon' | 'Polyline';

export interface MapGestureArmOpts {
    shape: MapGestureShape;
    /** Polyline only. */
    freehand?: boolean;
    arrow?: boolean;
}

export interface MapGestureResult {
    committed: boolean;
    shape?: MapGestureShape;
    params?: number[];
}

type ArmedListener = (armed: boolean) => void;
type ResultListener = (result: MapGestureResult) => void;

class MapGestureBridge {
    private postToWorker: ((msg: unknown) => void) | null = null;
    private armedListeners = new Set<ArmedListener>();
    private resultListeners = new Set<ResultListener>();
    private _armed = false;

    /** main.ts calls this once the game-processor worker is constructed. */
    setWorkerPost(post: (msg: unknown) => void): void {
        this.postToWorker = post;
    }

    get armed(): boolean {
        return this._armed;
    }

    /** Arm the shared capture in capture-only mode: the drawn shape comes
     *  back via `onResult` instead of being sent as a directive. `directiveType`/
     *  `groupId` are required by the wire message but unused by the worker
     *  when `captureOnly` is set — 0 is always safe. */
    arm(opts: MapGestureArmOpts): void {
        this.postToWorker?.({
            type: 'gp:armDirectiveShape',
            directiveType: 0,
            groupId: 0,
            shape: opts.shape,
            freehand: opts.freehand,
            arrow: opts.arrow,
            captureOnly: true,
        });
    }

    /** Abandon the in-progress capture (ESC also cancels it globally via
     *  main.ts, independent of this call). */
    cancel(): void {
        this.postToWorker?.({ type: 'gp:cancelDirectiveShape' });
    }

    onArmedChanged(cb: ArmedListener): () => void {
        this.armedListeners.add(cb);
        return () => this.armedListeners.delete(cb);
    }

    onResult(cb: ResultListener): () => void {
        this.resultListeners.add(cb);
        return () => this.resultListeners.delete(cb);
    }

    /** main.ts forwards `gp:directiveShapeArmed`/`gp:directiveShapeResult`
     *  worker messages here verbatim. */
    handleWorkerMessage(msg: {
        type: string;
        armed?: boolean;
        committed?: boolean;
        shape?: MapGestureShape;
        params?: number[];
    }): void {
        if (msg.type === 'gp:directiveShapeArmed') {
            this._armed = msg.armed === true;
            for (const cb of this.armedListeners) cb(this._armed);
        } else if (msg.type === 'gp:directiveShapeResult') {
            this._armed = false;
            const result: MapGestureResult = {
                committed: msg.committed === true,
                shape: msg.shape,
                params: msg.params,
            };
            for (const cb of this.resultListeners) cb(result);
        }
    }
}

export const mapGestureBridge = new MapGestureBridge();
