/**
 * ClipPlayer — the generic clip-player wrapper (PLAN-model-harness §2 last
 * row / §10 task 6): plays an authored .glb animation clip on one unit by
 * sampling the clip's Babylon `Animation` channels every render frame and
 * pushing parent-relative local matrices into EntityRenderer's per-piece
 * clip-pose override — the same per-piece pose path the server's
 * piece-state stream (`applyPieceState`) drives, so playback composes with
 * thin-instance rendering for free.
 *
 * This is the STABLE WRAPPER over "the client animator". Today the backend
 * is direct channel sampling on the render loop; PLAN-fx-offload replaces
 * it with the SoA animation system + baked animation textures (GPU
 * skinning). The public surface (extract / play / stop / state) must
 * survive that migration unchanged — reshape the internals, not the API.
 *
 * Scope (v0 — faithful to what the render path can currently show):
 *   - RIGID node animations (glTF channels targeting piece nodes) render
 *     correctly: each channel drives that piece's local TRS.
 *   - SKINNED (bone-weighted) clips do NOT deform geometry: pieces render
 *     as per-piece thin instances with no vertex skinning, so a skeletal
 *     clip only moves joint nodes (which usually carry no geometry).
 *     Those clips still list + play — geometry parented to joints moves —
 *     but true skinning arrives with fx-offload's animation textures (X1).
 */

import {
    Matrix,
    Quaternion,
    Vector3,
} from '@babylonjs/core';
import type { Animation } from '@babylonjs/core';

/** Animated properties glTF node channels can carry. Anything else
 *  (morph-target influences, material props) is skipped at extraction. */
type ChannelProp = 'position' | 'rotationQuaternion' | 'scaling';

/** All channels of one clip that target a single piece. */
export interface ClipChannelSet {
    pieceIdx: number;
    position?: Animation;
    rotationQuaternion?: Animation;
    scaling?: Animation;
}

/** One authored clip, retargeted from glb nodes to piece indices. Stored
 *  on the ModelTemplate; the source AnimationGroups are disposed after
 *  extraction (they'd otherwise autoplay against the detached template
 *  nodes — Babylon's glTF loader starts the first group by default). */
export interface ModelClip {
    name: string;
    /** Key-frame range, in the fps timebase below. */
    from: number;
    to: number;
    /** Frames per second the key times are expressed in (Babylon's glTF
     *  loader emits 60 fps keys). */
    fps: number;
    channels: ClipChannelSet[];
}

/** Structural view of Babylon's AnimationGroup — what extraction reads.
 *  Kept structural so vitest can feed plain fixture objects. */
export interface ClipSourceGroup {
    name: string;
    from: number;
    to: number;
    targetedAnimations: readonly { animation: Animation; target: unknown }[];
}

/**
 * Retarget imported AnimationGroups onto final piece indices.
 * `pieceIndexOf` resolves a channel's target node to the piece index the
 * template settled on after config reordering; channels whose target maps
 * to no piece (skeleton bones outside the piece tree, morph targets) are
 * dropped. Groups with no surviving channel are dropped entirely.
 */
export function extractClips(
    groups: readonly ClipSourceGroup[],
    pieceIndexOf: (target: unknown) => number | undefined,
): ModelClip[] {
    const out: ModelClip[] = [];
    for (const g of groups) {
        const byPiece = new Map<number, ClipChannelSet>();
        let fps = 0;
        for (const ta of g.targetedAnimations) {
            const prop = ta.animation.targetProperty as ChannelProp;
            if (prop !== 'position' && prop !== 'rotationQuaternion' && prop !== 'scaling') continue;
            const pieceIdx = pieceIndexOf(ta.target);
            if (pieceIdx === undefined || pieceIdx < 0) continue;
            let ch = byPiece.get(pieceIdx);
            if (!ch) {
                ch = { pieceIdx };
                byPiece.set(pieceIdx, ch);
            }
            ch[prop] = ta.animation;
            fps = Math.max(fps, ta.animation.framePerSecond || 0);
        }
        if (byPiece.size === 0) continue;
        out.push({
            name: g.name,
            from: g.from,
            to: g.to,
            fps: fps || 60,
            channels: [...byPiece.values()],
        });
    }
    return out;
}

/** Map elapsed wall time onto a clip frame. Looping wraps within
 *  [from, to); non-looping clamps at `to` and reports done (the caller
 *  holds the final pose). */
export function clipFrameAt(
    clip: Pick<ModelClip, 'from' | 'to' | 'fps'>,
    elapsedSec: number,
    speed: number,
    loop: boolean,
): { frame: number; done: boolean } {
    const len = Math.max(1e-6, clip.to - clip.from);
    const f = elapsedSec * speed * clip.fps;
    if (loop) return { frame: clip.from + (((f % len) + len) % len), done: false };
    if (f >= len) return { frame: clip.to, done: true };
    return { frame: clip.from + f, done: false };
}

/**
 * Sample every channel of `clip` at `frame` and compose parent-relative
 * local matrices. Unanimated properties of an animated piece fall back to
 * that piece's rest-pose TRS (`restLocals[pieceIdx]`, the template's
 * localMatrix); pieces with no channel at all are simply absent from the
 * returned pose — EntityRenderer keeps their rest transform.
 */
export function sampleClipPose(
    clip: ModelClip,
    restLocals: readonly Matrix[],
    frame: number,
): Map<number, Matrix> {
    const pose = new Map<number, Matrix>();
    const restScale = new Vector3();
    const restRot = new Quaternion();
    const restPos = new Vector3();
    for (const ch of clip.channels) {
        const rest = restLocals[ch.pieceIdx];
        if (!rest) continue;
        rest.decompose(restScale, restRot, restPos);
        const p = ch.position ? ch.position.evaluate(frame) as Vector3 : restPos;
        const r = ch.rotationQuaternion
            ? ch.rotationQuaternion.evaluate(frame) as Quaternion : restRot;
        const s = ch.scaling ? ch.scaling.evaluate(frame) as Vector3 : restScale;
        pose.set(ch.pieceIdx, Matrix.Compose(s, r, p));
    }
    return pose;
}

/** Where sampled poses go — EntityRenderer.setClipPose. Returns false
 *  when the unit no longer exists so playback can auto-stop. */
export interface ClipPoseSink {
    setClipPose(id: number, pose: ReadonlyMap<number, Matrix> | null): boolean;
}

export interface ClipPlayOpts {
    /** Loop until stopped (default true — the harness button toggles). */
    loop?: boolean;
    /** Playback rate multiplier (default 1). */
    speed?: number;
}

export interface ClipPlayerState {
    unitId: number;
    clip: string;
    loop: boolean;
    speed: number;
    frame: number;
    /** False once a non-looping clip has clamped at its last frame
     *  (the pose holds until stop()). */
    playing: boolean;
}

/** One playback at a time — the harness stages a single unit. */
export class ClipPlayer {
    private sink: ClipPoseSink;
    private now: () => number;
    private active: {
        unitId: number;
        clip: ModelClip;
        restLocals: readonly Matrix[];
        loop: boolean;
        speed: number;
        startMs: number;
        lastFrame: number;
        done: boolean;
    } | null = null;

    constructor(sink: ClipPoseSink, now: () => number = () => performance.now()) {
        this.sink = sink;
        this.now = now;
    }

    /** Start (replacing any current playback) and apply the first pose. */
    play(
        unitId: number,
        clip: ModelClip,
        restLocals: readonly Matrix[],
        opts: ClipPlayOpts = {},
    ): ClipPlayerState | null {
        this.stop();
        this.active = {
            unitId,
            clip,
            restLocals,
            loop: opts.loop ?? true,
            speed: opts.speed || 1,
            startMs: this.now(),
            lastFrame: clip.from,
            done: false,
        };
        this.tick();
        return this.state();
    }

    /** Clear the pose override; the unit returns to rest / server pose. */
    stop(): void {
        if (this.active) this.sink.setClipPose(this.active.unitId, null);
        this.active = null;
    }

    /** Render-loop hook. Auto-stops when the target unit disappears
     *  (death, respawn, LOS eviction); holds the final frame of a
     *  finished non-looping clip. */
    tick(): void {
        const a = this.active;
        if (!a || a.done) return;
        const { frame, done } = clipFrameAt(
            a.clip, (this.now() - a.startMs) / 1000, a.speed, a.loop);
        a.lastFrame = frame;
        const pose = sampleClipPose(a.clip, a.restLocals, frame);
        if (!this.sink.setClipPose(a.unitId, pose)) {
            this.active = null;
            return;
        }
        a.done = done;
    }

    state(): ClipPlayerState | null {
        const a = this.active;
        if (!a) return null;
        return {
            unitId: a.unitId,
            clip: a.clip.name,
            loop: a.loop,
            speed: a.speed,
            frame: a.lastFrame,
            playing: !a.done,
        };
    }
}
