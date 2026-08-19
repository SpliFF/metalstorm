/**
 * Replay playback bar — the pure half (PLAN-replay.md task 4b).
 *
 * The DOM half is verified in a browser against a real recording; what is
 * worth pinning here is the reading of a ReplayState: whose controls these
 * are, what the bar says when they are not yours, and the scrub arithmetic —
 * an off-by-one in `seekFrameFor` is a seek to the wrong minute of somebody's
 * match, and it would look like a server bug.
 */

import { describe, it, expect } from 'vitest';
import {
    describeReplayBar, seekFrameFor, shouldApplyDeepLinkSeek, SPEED_STEPS,
} from './replay-bar.js';
import type { ReplayStateInfo } from '../core/connection.js';

function state(over: Partial<ReplayStateInfo> = {}): ReplayStateInfo {
    return {
        startFrame: 0,
        endFrame: 6150,          // the real T2-a Metalstorm recording's length
        currentFrame: 0,
        paused: false,
        speed: 1,
        seeking: false,
        seekTarget: 0,
        controllerPlayerNum: 200,
        checkpointFrames: [],
        truncated: false,
        gameId: 'metalstorm',
        mapId: 'meridian_basin',
        povTeam: -1,
        ...over,
    };
}

describe('describeReplayBar', () => {
    it('reads the controls as yours when you hold them', () => {
        const m = describeReplayBar(state(), 200);
        expect(m.isController).toBe(true);
        expect(m.disabledReason).toBe('');
    });

    it('names the driver when someone else holds the controls', () => {
        const m = describeReplayBar(state({ controllerPlayerNum: 200 }), 201);
        expect(m.isController).toBe(false);
        expect(m.disabledReason).toContain('200');
    });

    it('does not claim the controls when nobody holds them', () => {
        // -1 is the "no watcher attached" value. A client whose own playerNum
        // was also -1 (unauthenticated) must not match it into ownership.
        const m = describeReplayBar(state({ controllerPlayerNum: -1 }), -1);
        expect(m.isController).toBe(false);
        expect(m.disabledReason).toContain('waiting');
    });

    it('shows position as a clock over the recording length', () => {
        // 6150 frames at 30 Hz = 205 s = 3:25; halfway is 1:42.
        const m = describeReplayBar(state({ currentFrame: 3075 }), 200);
        expect(m.positionLabel).toBe('1:42 / 3:25');
        expect(m.progress).toBeCloseTo(0.5, 3);
    });

    it('clamps progress rather than running off the end of the track', () => {
        // A recording's declared end frame and the frame the sim actually
        // reaches need not agree by one tick; the bar must not overflow.
        const m = describeReplayBar(state({ currentFrame: 9999 }), 200);
        expect(m.progress).toBe(1);
        const before = describeReplayBar(state({ currentFrame: -1 }), 200);
        expect(before.progress).toBe(0);
    });

    it('flips the play label with the paused flag', () => {
        expect(describeReplayBar(state({ paused: false }), 200).playLabel).toBe('❚❚');
        expect(describeReplayBar(state({ paused: true }), 200).playLabel).toBe('▶');
    });

    it('says a seek is in flight, with its destination', () => {
        const m = describeReplayBar(
            state({ seeking: true, seekTarget: 4800 }), 200);
        expect(m.status).toContain('seeking');
        expect(m.status).toContain('2:40');
    });

    it('says out loud that a truncated recording ends early', () => {
        // E1. Without this the bar just stops, which reads as a bug.
        expect(describeReplayBar(state({ truncated: true }), 200).status)
            .toContain('truncated');
    });

    it('reports the POV, global or team', () => {
        expect(describeReplayBar(state(), 200).status).toContain('global view');
        expect(describeReplayBar(state({ povTeam: 4 }), 200).status)
            .toContain('team 4');
    });

    it('explains the missing checkpoints rather than drawing an empty track', () => {
        // No checkpoints is also why a backward seek is refused, so the bar
        // says it before the watcher discovers it by being refused.
        const m = describeReplayBar(state(), 200);
        expect(m.tickPositions).toEqual([]);
        expect(m.status).toContain('forwards only');
    });

    it('carries the server refusal so the bar can show it', () => {
        // Live 2026-08-05: a refused backward seek reached the browser only as
        // a console error, so the click looked like a dead button. The reason
        // string is the whole point of refusing rather than clamping.
        const m = describeReplayBar(state(), 200, 'cannot seek backwards yet');
        expect(m.refusal).toBe('cannot seek backwards yet');
        expect(describeReplayBar(state(), 200).refusal).toBe('');
    });

    it('places checkpoint ticks along the track when a recording has them', () => {
        const m = describeReplayBar(
            state({ checkpointFrames: [0, 3075, 6150] }), 200);
        expect(m.tickPositions).toEqual([0, 0.5, 1]);
        expect(m.status).not.toContain('forwards only');
    });

    it('drops checkpoint ticks that fall outside the segment', () => {
        // A rollback segment (§6 E2) starts partway through the game, so its
        // header's startFrame is nonzero and stale ticks can precede it.
        const m = describeReplayBar(
            state({ startFrame: 1000, checkpointFrames: [500, 1000, 4000] }), 200);
        expect(m.tickPositions).toEqual([0, (4000 - 1000) / (6150 - 1000)]);
    });
});

describe('seekFrameFor', () => {
    it('maps a fraction of the track to a frame in the recording', () => {
        expect(seekFrameFor(state(), 0)).toBe(0);
        expect(seekFrameFor(state(), 1)).toBe(6150);
        expect(seekFrameFor(state(), 0.5)).toBe(3075);
    });

    it('respects a segment that does not start at frame 0', () => {
        const s = state({ startFrame: 1000 });
        expect(seekFrameFor(s, 0)).toBe(1000);
        expect(seekFrameFor(s, 1)).toBe(6150);
    });

    it('clamps a click that landed outside the track', () => {
        expect(seekFrameFor(state(), -0.2)).toBe(0);
        expect(seekFrameFor(state(), 1.5)).toBe(6150);
    });
});

describe('SPEED_STEPS', () => {
    it('stays inside the band the server will honour', () => {
        // ReplayControlDeck clamps to [0.25, 8]; a step outside it would be a
        // button whose label lies about what happens when you press it.
        for (const s of SPEED_STEPS) {
            expect(s).toBeGreaterThanOrEqual(0.25);
            expect(s).toBeLessThanOrEqual(8);
        }
        expect(SPEED_STEPS).toContain(1);
    });
});

describe('shouldApplyDeepLinkSeek', () => {
    // A `?watch=<file>&frame=N` deep link (task 4c). The frame arrives as an
    // ordinary seek rather than a `--replay-seek` launch flag, because a
    // replay server told to seek at launch stalls its network loop through the
    // whole fast-forward and the watcher times out before attaching.
    it('seeks forward when the controls are yours', () => {
        expect(shouldApplyDeepLinkSeek(state({ currentFrame: 60 }), 200, 3000)).toBe(true);
    });

    it('does nothing when someone else is driving the cast', () => {
        // Otherwise a deep link into a running cast yanks it, or — since the
        // server refuses — raises a toast the watcher never asked for.
        expect(shouldApplyDeepLinkSeek(state({ controllerPlayerNum: 201 }), 200, 3000))
            .toBe(false);
        expect(shouldApplyDeepLinkSeek(state({ controllerPlayerNum: -1 }), 200, 3000))
            .toBe(false);
    });

    it('does not re-queue a seek that is already running', () => {
        expect(shouldApplyDeepLinkSeek(
            state({ seeking: true, seekTarget: 3000 }), 200, 3000)).toBe(false);
    });

    it('refuses a target playback has already passed — that is a rewind', () => {
        expect(shouldApplyDeepLinkSeek(state({ currentFrame: 4000 }), 200, 3000)).toBe(false);
        expect(shouldApplyDeepLinkSeek(state({ currentFrame: 3000 }), 200, 3000)).toBe(false);
    });

    it('refuses a target past the end of the recording', () => {
        expect(shouldApplyDeepLinkSeek(state(), 200, 6150)).toBe(false);
        expect(shouldApplyDeepLinkSeek(state(), 200, 99999)).toBe(false);
    });

    it('treats no frame as no request', () => {
        expect(shouldApplyDeepLinkSeek(state(), 200, 0)).toBe(false);
    });
});
