/**
 * Clip-player tests (PLAN-model-harness §11 / task 6): AnimationGroup →
 * ModelClip extraction (retargeting onto final piece indices), frame
 * mapping (loop wrap, clamp, speed), channel sampling against real
 * Babylon Animation objects, and the ClipPlayer lifecycle (play/tick/
 * auto-stop when the unit disappears).
 */

import { describe, expect, it } from 'vitest';
import { Animation, Matrix, Quaternion, Vector3 } from '@babylonjs/core';
import {
    ClipPlayer,
    clipFrameAt,
    extractClips,
    sampleClipPose,
    type ClipSourceGroup,
    type ModelClip,
} from './clip-player.js';

/** A position channel: (0,0,0) at frame 0 → (10,0,0) at frame 30. */
function positionAnim(fps = 60): Animation {
    const a = new Animation('t', 'position', fps, Animation.ANIMATIONTYPE_VECTOR3);
    a.setKeys([
        { frame: 0, value: new Vector3(0, 0, 0) },
        { frame: 30, value: new Vector3(10, 0, 0) },
    ]);
    return a;
}

/** A rotation channel: identity at frame 0 → 90° about Y at frame 30. */
function rotationAnim(fps = 60): Animation {
    const a = new Animation('r', 'rotationQuaternion', fps, Animation.ANIMATIONTYPE_QUATERNION);
    a.setKeys([
        { frame: 0, value: Quaternion.Identity() },
        { frame: 30, value: Quaternion.RotationAxis(new Vector3(0, 1, 0), Math.PI / 2) },
    ]);
    return a;
}

const nodeA = { name: 'turret' };
const nodeB = { name: 'barrel' };
const nodeUnknown = { name: 'skeleton_bone_7' };

function group(name: string, tas: { animation: Animation; target: unknown }[]): ClipSourceGroup {
    return { name, from: 0, to: 30, targetedAnimations: tas };
}

describe('extractClips', () => {
    const pieceIndexOf = (t: unknown): number | undefined =>
        t === nodeA ? 2 : t === nodeB ? 5 : undefined;

    it('retargets channels onto piece indices and groups per piece', () => {
        const clips = extractClips([group('walk', [
            { animation: positionAnim(), target: nodeA },
            { animation: rotationAnim(), target: nodeA },
            { animation: positionAnim(), target: nodeB },
        ])], pieceIndexOf);
        expect(clips).toHaveLength(1);
        expect(clips[0].name).toBe('walk');
        expect(clips[0].fps).toBe(60);
        const byPiece = new Map(clips[0].channels.map((c) => [c.pieceIdx, c]));
        expect([...byPiece.keys()].sort()).toEqual([2, 5]);
        expect(byPiece.get(2)?.position).toBeDefined();
        expect(byPiece.get(2)?.rotationQuaternion).toBeDefined();
        expect(byPiece.get(5)?.position).toBeDefined();
        expect(byPiece.get(5)?.rotationQuaternion).toBeUndefined();
    });

    it('drops channels whose target maps to no piece, and clip-less groups', () => {
        const clips = extractClips([
            group('skinned-only', [{ animation: positionAnim(), target: nodeUnknown }]),
            group('mixed', [
                { animation: positionAnim(), target: nodeUnknown },
                { animation: positionAnim(), target: nodeA },
            ]),
        ], pieceIndexOf);
        expect(clips.map((c) => c.name)).toEqual(['mixed']);
        expect(clips[0].channels).toHaveLength(1);
        expect(clips[0].channels[0].pieceIdx).toBe(2);
    });

    it('skips non-TRS target properties', () => {
        const weird = new Animation('m', 'influence', 60, Animation.ANIMATIONTYPE_FLOAT);
        weird.setKeys([{ frame: 0, value: 0 }, { frame: 30, value: 1 }]);
        const clips = extractClips(
            [group('morph', [{ animation: weird, target: nodeA }])], pieceIndexOf);
        expect(clips).toEqual([]);
    });
});

describe('clipFrameAt', () => {
    const clip = { from: 0, to: 30, fps: 60 };

    it('maps elapsed seconds through fps and speed', () => {
        expect(clipFrameAt(clip, 0.25, 1, false)).toEqual({ frame: 15, done: false });
        expect(clipFrameAt(clip, 0.25, 2, false)).toEqual({ frame: 30, done: true });
    });

    it('looping wraps within [from, to)', () => {
        const { frame, done } = clipFrameAt(clip, 0.75, 1, true); // 45 frames → wraps to 15
        expect(frame).toBeCloseTo(15);
        expect(done).toBe(false);
    });

    it('non-looping clamps at the last frame and reports done', () => {
        expect(clipFrameAt(clip, 10, 1, false)).toEqual({ frame: 30, done: true });
    });

    it('honours a non-zero from offset', () => {
        const offset = { from: 10, to: 40, fps: 60 };
        expect(clipFrameAt(offset, 0.25, 1, false).frame).toBeCloseTo(25);
        expect(clipFrameAt(offset, 0.75, 1, true).frame).toBeCloseTo(25); // 45 → wrap 15 → +10
    });
});

describe('sampleClipPose', () => {
    function makeClip(): ModelClip {
        return {
            name: 'walk', from: 0, to: 30, fps: 60,
            channels: [{ pieceIdx: 0, position: positionAnim(), rotationQuaternion: rotationAnim() }],
        };
    }

    it('interpolates animated channels at the mid frame', () => {
        const pose = sampleClipPose(makeClip(), [Matrix.Identity()], 15);
        const m = pose.get(0)!;
        const pos = new Vector3(); const rot = new Quaternion(); const scl = new Vector3();
        m.decompose(scl, rot, pos);
        expect(pos.x).toBeCloseTo(5);
        // Halfway to 90° about Y.
        const expected = Quaternion.RotationAxis(new Vector3(0, 1, 0), Math.PI / 4);
        expect(Math.abs(Quaternion.Dot(rot, expected))).toBeCloseTo(1, 5);
        expect(scl.x).toBeCloseTo(1);
    });

    it('unanimated properties fall back to the rest-pose TRS', () => {
        const rest = Matrix.Compose(
            new Vector3(2, 2, 2), Quaternion.Identity(), new Vector3(0, 7, 0));
        const clip: ModelClip = {
            name: 'lift', from: 0, to: 30, fps: 60,
            channels: [{ pieceIdx: 0, position: positionAnim() }],
        };
        const m = sampleClipPose(clip, [rest], 30).get(0)!;
        const pos = new Vector3(); const rot = new Quaternion(); const scl = new Vector3();
        m.decompose(scl, rot, pos);
        expect(pos.x).toBeCloseTo(10);  // animated
        expect(pos.y).toBeCloseTo(0);   // position channel owns ALL of position
        expect(scl.x).toBeCloseTo(2);   // scale kept from rest pose
    });

    it('pieces without channels are absent (renderer keeps rest pose)', () => {
        const pose = sampleClipPose(makeClip(), [Matrix.Identity(), Matrix.Identity()], 0);
        expect(pose.has(0)).toBe(true);
        expect(pose.has(1)).toBe(false);
    });

    it('out-of-range rest index is skipped, not thrown', () => {
        const clip: ModelClip = {
            name: 'x', from: 0, to: 30, fps: 60,
            channels: [{ pieceIdx: 9, position: positionAnim() }],
        };
        expect(sampleClipPose(clip, [Matrix.Identity()], 0).size).toBe(0);
    });
});

describe('ClipPlayer', () => {
    function makeSink(): {
        sink: { setClipPose(id: number, pose: ReadonlyMap<number, Matrix> | null): boolean };
        calls: { id: number; pose: ReadonlyMap<number, Matrix> | null }[];
        known: Set<number>;
    } {
        const calls: { id: number; pose: ReadonlyMap<number, Matrix> | null }[] = [];
        const known = new Set<number>([42]);
        return {
            calls,
            known,
            sink: {
                setClipPose(id, pose) {
                    calls.push({ id, pose });
                    return pose === null ? true : known.has(id);
                },
            },
        };
    }
    const clip: ModelClip = {
        name: 'walk', from: 0, to: 30, fps: 60,
        channels: [{ pieceIdx: 0, position: positionAnim() }],
    };

    it('play applies the first pose immediately and reports state', () => {
        const { sink, calls } = makeSink();
        let t = 1000;
        const p = new ClipPlayer(sink, () => t);
        const st = p.play(42, clip, [Matrix.Identity()], { loop: true });
        expect(st).toMatchObject({ unitId: 42, clip: 'walk', loop: true, playing: true });
        expect(calls.filter((c) => c.pose !== null)).toHaveLength(1);

        t += 250; // quarter second → frame 15 → x=5
        p.tick();
        const last = calls[calls.length - 1];
        expect(last.pose!.get(0)!.m[12]).toBeCloseTo(5);
    });

    it('stop clears the pose override', () => {
        const { sink, calls } = makeSink();
        const p = new ClipPlayer(sink, () => 0);
        p.play(42, clip, [Matrix.Identity()]);
        p.stop();
        expect(calls[calls.length - 1]).toMatchObject({ id: 42, pose: null });
        expect(p.state()).toBeNull();
    });

    it('auto-stops when the unit disappears (death / respawn)', () => {
        const { sink, known } = makeSink();
        let t = 0;
        const p = new ClipPlayer(sink, () => t);
        p.play(42, clip, [Matrix.Identity()]);
        known.delete(42);
        t += 100;
        p.tick();
        expect(p.state()).toBeNull();
    });

    it('non-looping playback holds the final frame and stops advancing', () => {
        const { sink, calls } = makeSink();
        let t = 0;
        const p = new ClipPlayer(sink, () => t);
        p.play(42, clip, [Matrix.Identity()], { loop: false });
        t += 2000; // well past the 0.5 s clip
        p.tick();
        expect(p.state()).toMatchObject({ playing: false, frame: 30 });
        const applied = calls.filter((c) => c.pose !== null).length;
        t += 100;
        p.tick(); // done → no further pose writes
        expect(calls.filter((c) => c.pose !== null).length).toBe(applied);
    });

    it('replacing playback clears the previous unit pose first', () => {
        const { sink, calls, known } = makeSink();
        known.add(7);
        const p = new ClipPlayer(sink, () => 0);
        p.play(42, clip, [Matrix.Identity()]);
        p.play(7, clip, [Matrix.Identity()]);
        const clearIdx = calls.findIndex((c) => c.id === 42 && c.pose === null);
        expect(clearIdx).toBeGreaterThan(-1);
        expect(p.state()?.unitId).toBe(7);
    });
});
