/**
 * PLAN-fx-offload X4 — real `FxSinks` implementations for the two binding
 * types that need no new GPU/shader plumbing: `pieceSpin` (rides
 * EntityRenderer's existing clip-pose override slot) and `loopSound`
 * (rides AudioManager's loop-voice control added alongside this file).
 * `uvScroll`/`emitter` stay on `createStubSinks()` from fx-bindings.ts
 * until X1-X3 land (evidence-gated, out of scope this session).
 *
 * Kept out of fx-bindings.ts itself so that module stays Babylon/Audio-
 * free and unit-testable without a renderer or AudioContext.
 */

import { Matrix, Vector3 } from '@babylonjs/core';
import type { FxSinks, PieceSpinBinding, LoopSoundBinding, FxAxis } from './fx-bindings.js';

// ============================================================
// pieceSpin → EntityRenderer.setClipPose
// ============================================================

export interface PieceSpinRenderer {
    getPieceIndex(id: number, pieceName: string): number | null;
    getRestLocalMatrices(id: number): Matrix[] | null;
    setClipPose(id: number, pose: ReadonlyMap<number, Matrix> | null): boolean;
}

const AXIS_VECTOR: Record<FxAxis, Vector3> = {
    x: new Vector3(1, 0, 0),
    y: new Vector3(0, 1, 0),
    z: new Vector3(0, 0, 1),
};

export interface PieceSpinSink {
    spin: FxSinks['pieceSpin'];
    /**
     * Call once per frame, after every evaluate() call that frame has
     * returned. `setClipPose` replaces an entity's *entire* clip-pose map
     * per call, so a unit with two spinning pieces (e.g. left/right
     * wheels) needs one combined call, not one overwrite per binding —
     * this buffers per-entity across the frame's spin() calls and flushes
     * once. Entities untouched this frame are left alone: a piece whose
     * `when` condition just went false keeps its last angle (a stopped
     * wheel freezes instead of snapping back to rest), since it's simply
     * not written again, not removed from the persistent per-entity map.
     */
    flush(): void;
    /** Drop an entity's accumulated spin phase/pose (on death/despawn) and
     *  clear its EntityRenderer clip-pose override. Not yet wired to a
     *  live entity-removal call site — this module has no per-frame
     *  driver yet (PLAN-fx-offload task 3, the JS animation system,
     *  supplies the real caller); exposed so that caller can invoke it. */
    release(entityId: number): void;
}

export function createPieceSpinSink(renderer: PieceSpinRenderer): PieceSpinSink {
    const phase = new Map<number, number>();
    const pose = new Map<number, Map<number, Matrix>>();
    const touchedThisFrame = new Set<number>();

    const phaseKey = (entityId: number, pieceIdx: number): number => entityId * 4096 + pieceIdx;

    const spin: FxSinks['pieceSpin'] = (entityId, _defId, binding: PieceSpinBinding, rate, dt) => {
        const pieceIdx = renderer.getPieceIndex(entityId, binding.piece);
        if (pieceIdx === null) return;
        const restLocals = renderer.getRestLocalMatrices(entityId);
        if (!restLocals) return;

        const pKey = phaseKey(entityId, pieceIdx);
        const angle = (phase.get(pKey) ?? 0) + rate * dt;
        phase.set(pKey, angle);

        // Spin applied in the piece's own local frame, then the piece's
        // authored rest offset/orientation on top — see
        // springToBabylonLocal's multiply-order note in entity-renderer.ts
        // (q1.multiply(q2) applies q2 first). Not yet visually verified
        // against a live spinning model (no bindings-driven unit is
        // currently spawnable — see PLAN-fx-offload field notes); flip
        // the operand order here if a real wheel spins inside-out.
        const spinMatrix = Matrix.RotationAxis(AXIS_VECTOR[binding.axis], angle);
        const local = restLocals[pieceIdx].multiply(spinMatrix);

        let entityPose = pose.get(entityId);
        if (!entityPose) {
            entityPose = new Map();
            pose.set(entityId, entityPose);
        }
        entityPose.set(pieceIdx, local);
        touchedThisFrame.add(entityId);
    };

    const flush = (): void => {
        for (const entityId of touchedThisFrame) {
            const entityPose = pose.get(entityId);
            if (entityPose) renderer.setClipPose(entityId, entityPose);
        }
        touchedThisFrame.clear();
    };

    const release = (entityId: number): void => {
        pose.delete(entityId);
        touchedThisFrame.delete(entityId);
        for (const key of phase.keys()) {
            if (Math.floor(key / 4096) === entityId) phase.delete(key);
        }
        renderer.setClipPose(entityId, null);
    };

    return { spin, flush, release };
}

// ============================================================
// loopSound → AudioManager loop-voice control
// ============================================================

export interface LoopSoundAudio {
    playLoop(key: string, req: { buffer: AudioBuffer; x: number; y: number; z: number; volume?: number }): void;
    updateLoopPosition(key: string, x: number, y: number, z: number): void;
    stopLoop(key: string): void;
}

export interface LoopSoundPositioner {
    /** World position to play/reposition the loop at — typically the
     *  `attach` piece's world position, or the entity origin when `attach`
     *  is unset/unresolved. Null skips this frame's start/update (piece or
     *  entity not currently known, e.g. still streaming in). */
    resolve(entityId: number, attachPiece: string | undefined): { x: number; y: number; z: number } | null;
}

/** Resolves a sound-item name to its decoded AudioBuffer — the same
 *  lookup AudioManager.play() callers already perform against the loaded
 *  SoundItem/buffer cache before calling play(). */
export interface LoopSoundBufferResolver {
    resolveBuffer(soundName: string): AudioBuffer | null;
}

export function createLoopSoundSink(
    audio: LoopSoundAudio,
    positioner: LoopSoundPositioner,
    buffers: LoopSoundBufferResolver,
): Pick<FxSinks, 'loopSoundStart' | 'loopSoundUpdate' | 'loopSoundStop'> {
    return {
        loopSoundStart(key, entityId, _defId, binding: LoopSoundBinding) {
            const buffer = buffers.resolveBuffer(binding.sound);
            const pos = positioner.resolve(entityId, binding.attach);
            if (!buffer || !pos) return;
            audio.playLoop(key, { buffer, x: pos.x, y: pos.y, z: pos.z, volume: binding.volume ?? 1 });
        },
        loopSoundUpdate(key, entityId, _defId, binding: LoopSoundBinding) {
            const pos = positioner.resolve(entityId, binding.attach);
            if (!pos) return;
            audio.updateLoopPosition(key, pos.x, pos.y, pos.z);
        },
        loopSoundStop(key) {
            audio.stopLoop(key);
        },
    };
}
