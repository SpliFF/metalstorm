/**
 * CommandBuffer — client-side command debouncing and grouping.
 *
 * Coalesces rapid positional commands (drag-move, drag-attack) into
 * single grouped messages. Instead of sending a command per frame
 * during a drag operation, buffers commands and flushes at intervals.
 *
 * Debounce intervals per PLAN-orders.md:
 *   - Positional orders (move, attack-move): 100ms
 *   - Standing orders (fire state, etc.): 200ms
 *   - Maximum delay before forced flush: 200ms
 */

import { Connection } from './connection.js';

const DEBOUNCE_POSITIONAL = 100; // ms
const DEBOUNCE_STANDING = 200;   // ms
const MAX_DELAY = 200;           // ms

/** A pending command waiting to be sent. */
interface PendingCommand {
    commandId: number;
    squadIds: number[];
    params: number[];
    options: number;
    timeoutFrames: number;
    timestamp: number;
}

/** Standard Spring command IDs. Mirrors rts/Sim/Units/CommandAI/Command.h. */
export const CMD = {
    STOP: 0,
    /** Insert an order into an existing queue. Params:
     *    [param0, newCmdId, newOpts, ...newParams]
     *  By default (no OPT.ALT on the INSERT itself) `param0` is a TAG:
     *  the engine looks up the queued order with that tag and inserts
     *  before it (after it with OPT.RIGHT). This tag-anchored form is
     *  what waypoint-drag uses to reorder atomically. With OPT.ALT set,
     *  `param0` is instead a queue POSITION index (negatives count from
     *  the end; clamped to the queue length). See
     *  CommandAI::ExecuteInsert. */
    INSERT: 1,
    /** Remove queued orders by tag (default) or by cmdId (with OPT.ALT).
     *  Params are the list of tags / cmdIds to drop. Per-waypoint
     *  revocation uses this with a single tag and no flags. See
     *  CommandAI::ExecuteRemove. */
    REMOVE: 2,
    WAIT: 5,
    MOVE: 10,
    PATROL: 15,
    FIGHT: 16,
    ATTACK: 20,
    AREA_ATTACK: 21,
    GUARD: 25,
    GROUPSELECT: 35,
    GROUPADD: 36,
    GROUPCLEAR: 37,
    REPAIR: 40,
    FIRE_STATE: 45,
    MOVE_STATE: 50,
    SETBASE: 55,
    INTERNAL: 60,
    SELFD: 65,
    LOAD_UNITS: 75,
    LOAD_ONTO: 76,
    UNLOAD_UNITS: 80,
    UNLOAD_UNIT: 81,
    ONOFF: 85,
    RECLAIM: 90,
    CLOAK: 95,
    STOCKPILE: 100,
    MANUALFIRE: 105,
    RESTORE: 110,
    REPEAT: 115,
    TRAJECTORY: 120,
    RESURRECT: 125,
    CAPTURE: 130,
    AUTOREPAIRLEVEL: 135,
    LOOPBACKATTACK: 140,
    IDLEMODE: 145,
} as const;

/** Spring command-option bitfield (matches rts/Sim/Units/CommandAI/Command.h). */
export const OPT = {
    META: 4,
    INTERNAL: 8,
    RIGHT: 16,
    SHIFT: 32,
    CONTROL: 64,
    ALT: 128,
} as const;

/** Returns true if a command is positional (benefits from debouncing). */
function isPositionalCommand(cmdId: number): boolean {
    return cmdId === CMD.MOVE || cmdId === CMD.ATTACK ||
           cmdId === CMD.FIGHT || cmdId === CMD.PATROL ||
           cmdId === CMD.AREA_ATTACK;
}

/** Hook invoked before a command is sent to the server. Returns true if
 *  any widget consumed the order — the command is then dropped. Post-GW4
 *  the CommandBuffer lives in the game-processor worker alongside the
 *  LuaUI runtime, so gpInit wires this synchronously to lua-ui-host's
 *  dispatchCommandNotify (widgetHandler:CommandNotify) so widget-side
 *  handlers (cmd_no_duplicate_orders, cmd_raw_move_issue,
 *  cmd_keep_target, ...) can veto natively-issued orders — matching
 *  Recoil, where every GUI command runs luaUI->CommandNotify first. A
 *  Promise return is still accepted for async gates (fail-open on
 *  rejection). */
export type CommandNotifier = (
    cmdId: number,
    params: readonly number[],
    options: number,
) => boolean | Promise<boolean>;

export class CommandBuffer {
    private connection: Connection;
    private pending: PendingCommand | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private notifier: CommandNotifier | null = null;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    /** Install (or clear) the CommandNotify gate. Wired from gpInit
     *  (game-processor.ts) on every CommandBuffer owner (worker-selection /
     *  worker-command-modes / worker-build-placement). */
    setNotifier(fn: CommandNotifier | null): void {
        this.notifier = fn;
    }

    /**
     * Queue a command. If a similar command is already pending for the
     * same squads, it gets replaced (debounced). Otherwise the previous
     * pending command is flushed first.
     */
    issueCommand(
        commandId: number,
        squadIds: number[],
        params: number[],
        options: number = 0,
        timeoutFrames: number = 0,
    ): void {
        const now = performance.now();

        // If there's a pending command that can be coalesced
        if (this.pending &&
            this.pending.commandId === commandId &&
            arraysEqual(this.pending.squadIds, squadIds)) {
            // Replace params (latest position wins)
            this.pending.params = params;
            this.pending.options = options;

            // Check max delay
            if (now - this.pending.timestamp >= MAX_DELAY) {
                this.flush();
            }
            return;
        }

        // Flush any existing pending command
        if (this.pending) {
            this.flush();
        }

        // Buffer the new command
        this.pending = {
            commandId,
            squadIds,
            params,
            options,
            timeoutFrames,
            timestamp: now,
        };

        // Set debounce timer
        const delay = isPositionalCommand(commandId) ? DEBOUNCE_POSITIONAL : DEBOUNCE_STANDING;
        this.flushTimer = setTimeout(() => this.flush(), delay);
    }

    /** Send a command immediately (no debouncing). */
    issueImmediate(
        commandId: number,
        squadIds: number[],
        params: number[],
        options: number = 0,
        timeoutFrames: number = 0,
    ): void {
        // Flush any pending first
        if (this.pending) this.flush();

        this.sendCommand(commandId, squadIds, params, options, timeoutFrames);
    }

    /** Flush the pending command now. */
    flush(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (!this.pending) return;

        const p = this.pending;
        this.pending = null;
        this.sendCommand(p.commandId, p.squadIds, p.params, p.options, p.timeoutFrames);
    }

    private sendCommand(
        commandId: number,
        squadIds: number[],
        params: number[],
        options: number,
        timeoutFrames: number,
    ): void {
        // If a CommandNotify gate is wired, run it before sending so
        // widgets that register widgetHandler.CommandNotify
        // (cmd_no_duplicate_orders, cmd_raw_move_issue, cmd_keep_target,
        // ...) can veto the order. Returning true from any widget
        // consumes the command — we drop it silently to match Spring's
        // contract. Post-GW4 the LuaUI runtime shares this worker, so
        // the gpInit-wired notifier (dispatchCommandNotify) is
        // synchronous and the send keeps its ordering; a Promise return
        // (async gate) defers the send and fails open on rejection.
        if (this.notifier) {
            let result: boolean | Promise<boolean>;
            try {
                result = this.notifier(commandId, params, options);
            } catch {
                result = false;
            }
            if (typeof result !== 'boolean') {
                void (async () => {
                    let consumed = false;
                    try {
                        consumed = await result;
                    } catch {
                        consumed = false;
                    }
                    if (consumed) return;
                    this.connection.sendPlayerCommand(
                        commandId, squadIds, params, options, timeoutFrames);
                })();
                return;
            }
            if (result) return;  // vetoed — drop the command
        }

        // Delegate to Connection.sendPlayerCommand so all client-issued
        // commands share a single monotonic sequence counter
        // (`Connection.commandSequence`). Without this, widget-issued
        // commands (lua-ui-host giveOrder → connection.sendPlayerCommand)
        // and natively-issued commands had independent counters; once
        // the widget counter outran ours, the server rejected our
        // commands as "stale sequence" and silently dropped them. That's
        // the symptom that made factory build clicks do nothing.
        this.connection.sendPlayerCommand(
            commandId, squadIds, params, options, timeoutFrames);
    }

    dispose(): void {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pending = null;
    }
}

function arraysEqual(a: number[], b: number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
