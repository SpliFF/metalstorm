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

import * as flatbuffers from 'flatbuffers';
import { Connection } from './connection.js';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { PlayerCommand } from '../protocol/spring-web/player-command.js';

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

/** Standard Spring command IDs. */
export const CMD = {
    STOP: 0,
    MOVE: 10,
    PATROL: 15,
    FIGHT: 16,
    ATTACK: 20,
    AREA_ATTACK: 21,
    GUARD: 25,
    REPAIR: 40,
    FIRE_STATE: 45,
    MOVE_STATE: 50,
    LOAD_UNITS: 75,
    UNLOAD_UNITS: 80,
    RECLAIM: 90,
    CLOAK: 95,
} as const;

/** Returns true if a command is positional (benefits from debouncing). */
function isPositionalCommand(cmdId: number): boolean {
    return cmdId === CMD.MOVE || cmdId === CMD.ATTACK ||
           cmdId === CMD.FIGHT || cmdId === CMD.PATROL ||
           cmdId === CMD.AREA_ATTACK;
}

export class CommandBuffer {
    private connection: Connection;
    private pending: PendingCommand | null = null;
    private sequence = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(connection: Connection) {
        this.connection = connection;
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
        if (!this.connection.authenticated) return;

        this.sequence++;
        const builder = new flatbuffers.Builder(256);

        const squadVec = PlayerCommand.createSquadIdsVector(builder, squadIds);
        const paramVec = PlayerCommand.createParamsVector(builder, params);

        PlayerCommand.startPlayerCommand(builder);
        PlayerCommand.addSequence(builder, this.sequence);
        PlayerCommand.addCommandId(builder, commandId);
        PlayerCommand.addSquadIds(builder, squadVec);
        PlayerCommand.addParams(builder, paramVec);
        PlayerCommand.addOptions(builder, options);
        PlayerCommand.addTimeoutFrames(builder, timeoutFrames);
        const cmd = PlayerCommand.endPlayerCommand(builder);

        this.connection.sendClientMessage(builder, ClientPayload.PlayerCommand, cmd);
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
