/**
 * ScriptAPI — client-side scripting interface.
 *
 * Per PLAN-scripting.md, this is the "Core Engine API" that both
 * JS widgets and Lua WASM scripts can call. It provides read access
 * to game state received from the server and the ability to send
 * commands back.
 *
 * This replaces Spring's gl.* / Spring.* Lua API on the client side.
 * Commands are buffered and sent through the Connection.
 */

import type { Connection } from './connection.js';
import type { EntityStateSnapshot } from './entity-state.js';
import { CommandBuffer, CMD } from './command-buffer.js';

/** Entity data cached from server state updates. */
export interface EntityData {
    id: number;
    defId: number;
    team: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    health: number;
}

export class ScriptAPI {
    private entities = new Map<number, EntityData>();
    private commandBuffer: CommandBuffer;
    private _frame = 0;

    constructor(connection: Connection) {
        this.commandBuffer = new CommandBuffer(connection);
    }

    /** Current game frame as reported by last entity state update. */
    get frame(): number { return this._frame; }

    /** Get all known entities. */
    getEntities(): IterableIterator<EntityData> {
        return this.entities.values();
    }

    /** Get a specific entity by ID. */
    getEntity(id: number): EntityData | undefined {
        return this.entities.get(id);
    }

    /** Get entities matching a filter. */
    findEntities(filter: (e: EntityData) => boolean): EntityData[] {
        const result: EntityData[] = [];
        for (const e of this.entities.values()) {
            if (filter(e)) result.push(e);
        }
        return result;
    }

    /** Get entities for a specific team. */
    getTeamEntities(team: number): EntityData[] {
        return this.findEntities(e => e.team === team);
    }

    /** Issue a command to units (debounced). */
    command(commandId: number, unitIds: number[], params: number[], options: number = 0): void {
        this.commandBuffer.issueCommand(commandId, unitIds, params, options);
    }

    /** Issue a move command. */
    moveCommand(unitIds: number[], x: number, y: number, z: number, queue: boolean = false): void {
        this.commandBuffer.issueCommand(CMD.MOVE, unitIds, [x, y, z], queue ? 32 : 0);
    }

    /** Issue an attack command on a target unit. */
    attackCommand(unitIds: number[], targetId: number, queue: boolean = false): void {
        this.commandBuffer.issueCommand(CMD.ATTACK, unitIds, [targetId], queue ? 32 : 0);
    }

    /** Issue a stop command. */
    stopCommand(unitIds: number[]): void {
        this.commandBuffer.issueImmediate(CMD.STOP, unitIds, []);
    }

    /** Issue a guard command. */
    guardCommand(unitIds: number[], targetId: number, queue: boolean = false): void {
        this.commandBuffer.issueCommand(CMD.GUARD, unitIds, [targetId], queue ? 32 : 0);
    }

    /** Issue a patrol command. */
    patrolCommand(unitIds: number[], x: number, y: number, z: number, queue: boolean = false): void {
        this.commandBuffer.issueCommand(CMD.PATROL, unitIds, [x, y, z], queue ? 32 : 0);
    }

    // --- Internal: called by the connection layer ---

    /** Update entity data from a server state snapshot. */
    _updateFromSnapshot(snapshot: EntityStateSnapshot, isDelta: boolean): void {
        if (!snapshot.entityIds) return;

        for (let i = 0; i < snapshot.count; i++) {
            const id = snapshot.entityIds[i];
            let ent = this.entities.get(id);
            if (!ent) {
                ent = { id, defId: 0, team: 0, x: 0, y: 0, z: 0, heading: 0, health: 1 };
                this.entities.set(id, ent);
            }
            if (snapshot.positionsX) ent.x = snapshot.positionsX[i];
            if (snapshot.positionsY) ent.y = snapshot.positionsY[i];
            if (snapshot.positionsZ) ent.z = snapshot.positionsZ[i];
            if (snapshot.headings) ent.heading = snapshot.headings[i];
            if (snapshot.defIds) ent.defId = snapshot.defIds[i];
            if (snapshot.teams) ent.team = snapshot.teams[i];
            if (snapshot.health) ent.health = snapshot.health[i] / 65535;
        }

        if (!isDelta) {
            const seen = new Set<number>();
            for (let i = 0; i < snapshot.count; i++) seen.add(snapshot.entityIds[i]);
            for (const id of this.entities.keys()) {
                if (!seen.has(id)) this.entities.delete(id);
            }
        }
    }

    _setFrame(frame: number): void {
        this._frame = frame;
    }

    dispose(): void {
        this.commandBuffer.dispose();
        this.entities.clear();
    }
}

/** Re-export CMD constants for widget use. */
export { CMD } from './command-buffer.js';
