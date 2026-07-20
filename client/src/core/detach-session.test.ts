import { describe, it, expect } from 'vitest';
import { DetachSessionManager, DEFAULT_PARK_TTL_MS } from './detach-session.js';

// PLAN-quickstart.md Part B (§3.1/§3.2 + edge cases E4/E5): the pure
// keying/TTL/generation bookkeeping "where the bugs live" (§5).

describe('DetachSessionManager', () => {
    it('starts un-parked with generation 0', () => {
        const m = new DetachSessionManager();
        expect(m.isParked).toBe(false);
        expect(m.session).toBeNull();
        expect(m.currentGeneration).toBe(0);
    });

    it('park() records the session and bumps the generation', () => {
        const m = new DetachSessionManager();
        const gen = m.park('room-7', 5001, 1_000);
        expect(gen).toBe(1);
        expect(m.isParked).toBe(true);
        expect(m.session).toEqual({
            roomId: 'room-7', gamePort: 5001, generation: 1, parkedAtMs: 1_000,
        });
        expect(m.currentGeneration).toBe(1);
    });

    it('resyncs re-entry into the SAME room+port within the TTL', () => {
        const m = new DetachSessionManager();
        m.park('room-7', 5001, 1_000);
        expect(m.planReentry('room-7', 5001, 2_000)).toBe('resync');
    });

    it('full-boots a cold start (nothing parked)', () => {
        const m = new DetachSessionManager();
        expect(m.planReentry('room-7', 5001, 2_000)).toBe('full-boot');
    });

    it('full-boots re-entry into a DIFFERENT room', () => {
        const m = new DetachSessionManager();
        m.park('room-7', 5001, 1_000);
        expect(m.planReentry('room-9', 5001, 2_000)).toBe('full-boot');
    });

    it('full-boots when the game server was restarted on a new port (E5)', () => {
        const m = new DetachSessionManager();
        m.park('room-7', 5001, 1_000);
        // Same room id, but the restarted room spawned a fresh server ⇒ new port.
        expect(m.planReentry('room-7', 5002, 2_000)).toBe('full-boot');
    });

    it('full-boots once the parked session has outlived its TTL', () => {
        const m = new DetachSessionManager();
        m.park('room-7', 5001, 1_000);
        const justAfter = 1_000 + DEFAULT_PARK_TTL_MS + 1;
        expect(m.isExpired(justAfter)).toBe(true);
        expect(m.planReentry('room-7', 5001, justAfter)).toBe('full-boot');
        // ...but exactly at the TTL boundary it is still a resync.
        expect(m.isExpired(1_000 + DEFAULT_PARK_TTL_MS)).toBe(false);
        expect(m.planReentry('room-7', 5001, 1_000 + DEFAULT_PARK_TTL_MS)).toBe('resync');
    });

    it('honours a custom TTL', () => {
        const m = new DetachSessionManager(5_000);
        m.park('r', 1, 0);
        expect(m.planReentry('r', 1, 5_000)).toBe('resync');
        expect(m.planReentry('r', 1, 5_001)).toBe('full-boot');
    });

    it('clear() drops the parked session without touching the generation', () => {
        const m = new DetachSessionManager();
        m.park('room-7', 5001, 1_000);
        m.clear();
        expect(m.isParked).toBe(false);
        expect(m.session).toBeNull();
        expect(m.currentGeneration).toBe(1); // generation is monotonic
        expect(m.planReentry('room-7', 5001, 1_100)).toBe('full-boot');
    });

    it('bumpGeneration() advances the generation for stale-async guards', () => {
        const m = new DetachSessionManager();
        expect(m.bumpGeneration()).toBe(1);
        expect(m.bumpGeneration()).toBe(2);
        // A detach after two manual bumps continues the monotonic sequence.
        expect(m.park('r', 1, 0)).toBe(3);
    });

    it('each detach/re-enter cycle strictly increases the generation', () => {
        const m = new DetachSessionManager();
        const g1 = m.park('r', 1, 0);        // detach #1
        m.bumpGeneration(); m.clear();        // re-enter #1
        const g2 = m.park('r', 1, 100);      // detach #2
        expect(g2).toBeGreaterThan(g1);
    });
});
