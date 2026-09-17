/**
 * terrain-knowledge-is-LOS, K0. See ./DESIGN-TERRAIN-KNOWLEDGE.md.
 *
 * Two halves:
 *
 *  1. The parser and the mask semantics (pure — no Babylon).
 *  2. **A wiring guard that asserts the FILES.** A whitelist emitter silently
 *     drops keys it does not know, and a new envelope has to be registered in
 *     more than one place; the trap that bites is a message that parses
 *     perfectly and is never dispatched. A round-trip test would pass with the
 *     dispatcher arm deleted, so this reads connection.ts and net-inspector.ts
 *     off disk instead.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { NullEngine, Scene } from '@babylonjs/core';
import {
    parseTerrainKnowledge, TerrainKnowledgeGate, ENVELOPE_TERRAIN_KNOWLEDGE,
    KNOWLEDGE_ALLY_GLOBAL, type TerrainKnowledgeMask,
} from './terrain-knowledge';
import { buildTerrainMesh, type MapDimensions, type TerrainMeshGroup } from './terrain.js';

/** Build an envelope-0x0A PAYLOAD (envelope byte already stripped, the way the
 *  dispatcher hands it over). `known` is one byte per chunk, row-major. */
function encode(
    allyTeam: number, chunksX: number, chunksZ: number, frame: number,
    known: number[],
): Uint8Array {
    const planeBytes = (chunksX * chunksZ + 7) >> 3;
    const out = new Uint8Array(7 + planeBytes);
    out[0] = allyTeam; out[1] = chunksX; out[2] = chunksZ;
    out[3] = frame & 0xff;
    out[4] = (frame >>> 8) & 0xff;
    out[5] = (frame >>> 16) & 0xff;
    out[6] = (frame >>> 24) & 0xff;
    for (let i = 0; i < known.length; i++)
        if (known[i]) out[7 + (i >> 3)] |= 1 << (7 - (i & 7));
    return out;
}

describe('parseTerrainKnowledge', () => {
    it('round-trips an 8x8 mask, MSB-first and row-major', () => {
        const known = new Array(64).fill(0);
        known[0] = 1;    // chunk (0,0)
        known[7] = 1;    // chunk (7,0)
        known[8] = 1;    // chunk (0,1)
        known[63] = 1;   // chunk (7,7)
        const mask = parseTerrainKnowledge(encode(0, 8, 8, 1234, known));
        expect(mask).not.toBeNull();
        expect(mask!.allyTeam).toBe(0);
        expect(mask!.chunksX).toBe(8);
        expect(mask!.chunksZ).toBe(8);
        expect(mask!.frame).toBe(1234);
        expect(mask!.known.length).toBe(64);
        expect(mask!.known[0]).toBe(1);
        expect(mask!.known[7]).toBe(1);
        expect(mask!.known[8]).toBe(1);
        expect(mask!.known[63]).toBe(1);
        expect(Array.from(mask!.known).filter(Boolean).length).toBe(4);
    });

    it('is 15 bytes on the wire for a full 8x8 map — the number the whole '
        + 'design rests on', () => {
        // 1 envelope + 3 header + 4 frame + 8 plane. Small enough that sending
        // the ENTIRE mask every second beats any delta scheme, which is what
        // makes the message idempotent (design §4.2).
        expect(encode(0, 8, 8, 0, new Array(64).fill(1)).length).toBe(7 + 8);
    });

    it('handles a non-square grid', () => {
        const known = new Array(32).fill(0);
        known[4] = 1;    // chunksX = 4 → chunk (0,1)
        const mask = parseTerrainKnowledge(encode(2, 4, 8, 0, known));
        expect(mask!.chunksX).toBe(4);
        expect(mask!.chunksZ).toBe(8);
        expect(mask!.known.length).toBe(32);
        expect(mask!.known[4]).toBe(1);
    });

    it('decodes the Global-spectator ally value', () => {
        const mask = parseTerrainKnowledge(
            encode(KNOWLEDGE_ALLY_GLOBAL, 8, 8, 0, new Array(64).fill(1)));
        expect(mask!.allyTeam).toBe(KNOWLEDGE_ALLY_GLOBAL);
        expect(Array.from(mask!.known).every((v) => v === 1)).toBe(true);
    });

    it('decodes a large frame number without sign trouble', () => {
        const mask = parseTerrainKnowledge(encode(0, 8, 8, 3_000_000, []));
        expect(mask!.frame).toBe(3_000_000);
    });

    it('refuses malformed input rather than returning a partial mask', () => {
        // A mask that is confidently wrong is worse than no mask: it would
        // hide real ground.
        expect(parseTerrainKnowledge(new Uint8Array(0))).toBeNull();
        expect(parseTerrainKnowledge(new Uint8Array(6))).toBeNull();
        // Header says 8x8 (8 plane bytes) but only 3 arrived.
        expect(parseTerrainKnowledge(new Uint8Array(7 + 3).fill(8))).toBeNull();
        // Zero-sized grid.
        expect(parseTerrainKnowledge(encode(0, 0, 8, 0, []))).toBeNull();
        expect(parseTerrainKnowledge(encode(0, 8, 0, 0, []))).toBeNull();
    });

    it('reads at any byte offset (the dispatcher hands over a subarray)', () => {
        const full = new Uint8Array(1 + 15);
        full[0] = ENVELOPE_TERRAIN_KNOWLEDGE;
        full.set(encode(1, 8, 8, 7, (() => {
            const k = new Array(64).fill(0); k[5] = 1; return k;
        })()), 1);
        const mask = parseTerrainKnowledge(full.subarray(1));
        expect(mask!.allyTeam).toBe(1);
        expect(mask!.frame).toBe(7);
        expect(mask!.known[5]).toBe(1);
    });
});

describe('the envelope is registered in every file that must know it', () => {
    const read = (rel: string): string =>
        readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

    it('terrain-knowledge.ts and the C++ Protocol.h agree on 0x0A', () => {
        expect(ENVELOPE_TERRAIN_KNOWLEDGE).toBe(0x0a);
        const protocol = read('../../../rts/Server/Protocol.h');
        expect(protocol).toMatch(
            /constexpr uint8_t ENVELOPE_TERRAIN_KNOWLEDGE = 0x0A;/);
        // And the builder that actually emits it exists.
        expect(protocol).toContain('BuildTerrainKnowledge');
    });

    it('connection.ts dispatches it — the arm, not just the import', () => {
        const conn = read('./connection.ts');
        expect(conn).toContain('ENVELOPE_TERRAIN_KNOWLEDGE');
        expect(conn).toContain('parseTerrainKnowledge');
        expect(conn).toContain('onTerrainKnowledge');
        // The dispatch arm itself. Without this the message parses perfectly
        // and is silently dropped, which is exactly the failure a round-trip
        // test cannot see.
        expect(conn).toMatch(
            /envelope === ENVELOPE_TERRAIN_KNOWLEDGE/);
    });

    it('game-processor.ts consumes the event', () => {
        const gp = read('./game-processor.ts');
        expect(gp).toContain('onTerrainKnowledge:');
        expect(gp).toContain('TerrainKnowledgeGate');
    });

    it('net-inspector.ts names it, so the bandwidth tally is not a hex blob',
        () => {
            expect(read('./net-inspector.ts')).toMatch(/0x0a:\s*'TerrainKnowledge'/);
        });

    it('the server actually streams it', () => {
        const streamer = read('../../../rts/Server/StateStreamer.cpp');
        expect(streamer).toContain('StreamTerrainKnowledge');
        expect(streamer).toContain('BuildTerrainKnowledge');
        // Gated on the modoption: a stock game must emit nothing at all.
        expect(streamer).toContain('terrainknowledge');
        // And it is actually called from the tick, not merely defined.
        expect(streamer).toMatch(/StreamTerrainKnowledge\(0\);/);
    });

    it('0x0A does not collide with an envelope already in use', () => {
        const conn = read('./connection.ts');
        const used = [...conn.matchAll(/^const ENVELOPE_\w+ = (0x[0-9a-fA-F]+);/gm)]
            .map((m) => Number(m[1]));
        expect(used).not.toContain(ENVELOPE_TERRAIN_KNOWLEDGE);
        expect(used.length).toBeGreaterThan(4);   // the guard read something
    });
});

describe('TerrainKnowledgeGate — the client contract', () => {
    const DIMS: MapDimensions = {
        mapx: 1024, mapy: 1024, squareSize: 8,
        minHeight: 0, maxHeight: 200,
    };

    function makeGate(): { gate: TerrainKnowledgeGate; group: TerrainMeshGroup;
                           scene: Scene; engine: NullEngine } {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        // Deliberately tiny chunks so the mesh build is cheap; the gate does
        // not care what chunkQuads is, only that both sides agree.
        const group = buildTerrainMesh(
            scene, DIMS, new Uint16Array(1025 * 1025), { chunkQuads: 128 });
        return { gate: new TerrainKnowledgeGate(scene, group), group, scene, engine };
    }

    function mask(group: TerrainMeshGroup, known: number[]): TerrainKnowledgeMask {
        return {
            allyTeam: 0,
            chunksX: group.plan.chunksX,
            chunksZ: group.plan.chunksZ,
            frame: 1,
            known: Uint8Array.from(known),
        };
    }

    it('is inert until the first mask — stock behaviour is the default', () => {
        const { gate, group, engine } = makeGate();
        expect(gate.active).toBe(false);
        // Inert means "everything is known", so nothing anywhere changes.
        expect(gate.isChunkKnown(0, 0)).toBe(true);
        expect(gate.isChunkKnown(7, 7)).toBe(true);
        expect(gate.isPointKnown(60000, 60000)).toBe(true);
        for (const m of group.allMeshes) expect(m.isEnabled()).toBe(true);
        engine.dispose();
    });

    it('hides unknown chunks and keeps known ones', () => {
        const { gate, group, scene, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        const known = new Array(n).fill(0);
        known[0] = 1;   // only chunk (0,0)
        expect(gate.apply(mask(group, known))).toBe(true);
        expect(gate.active).toBe(true);

        expect(gate.isChunkKnown(0, 0)).toBe(true);
        expect(gate.isChunkKnown(1, 0)).toBe(false);
        expect(group.chunks[0].lod0.mesh.isEnabled()).toBe(true);
        expect(group.chunks[1].lod0.mesh.isEnabled()).toBe(false);
        // An unknown chunk must also leave the pick set — otherwise a click on
        // the void lands on ground the player cannot see.
        expect(group.chunks[1].lod0.mesh.isPickable).toBe(false);

        // And a fog curtain now stands at the frontier.
        expect(scene.getMeshByName('terrainFogCurtain')).not.toBeNull();
        engine.dispose();
    });

    it('ORs — a replayed or reordered older mask cannot un-reveal', () => {
        const { gate, group, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;

        const first = new Array(n).fill(0); first[0] = 1; first[1] = 1;
        expect(gate.apply(mask(group, first))).toBe(true);

        // A stale mask from before chunk 1 was revealed, arriving late. The
        // entity lane is newest-wins and gives no ordering, so this WILL
        // happen; it must be a no-op, not a regression.
        const stale = new Array(n).fill(0); stale[0] = 1;
        expect(gate.apply(mask(group, stale))).toBe(false);
        expect(gate.isChunkKnown(1, 0)).toBe(true);
        expect(group.chunks[1].lod0.mesh.isEnabled()).toBe(true);
        engine.dispose();
    });

    it('is idempotent — applying the same mask twice changes nothing', () => {
        const { gate, group, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        const known = new Array(n).fill(0); known[3] = 1;
        expect(gate.apply(mask(group, known))).toBe(true);
        expect(gate.stats().revisions).toBe(1);
        expect(gate.apply(mask(group, known))).toBe(false);
        expect(gate.apply(mask(group, known))).toBe(false);
        expect(gate.stats().revisions).toBe(1);
        engine.dispose();
    });

    it('self-heals after a drop — the next full mask carries everything', () => {
        const { gate, group, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        expect(gate.apply(mask(group, (() => {
            const k = new Array(n).fill(0); k[0] = 1; return k;
        })()))).toBe(true);
        // Three reveals happened; two of the messages were dropped. The next
        // one is still the WHOLE mask, so nothing has to be retransmitted.
        const caughtUp = new Array(n).fill(0);
        caughtUp[0] = 1; caughtUp[1] = 1; caughtUp[2] = 1; caughtUp[3] = 1;
        expect(gate.apply(mask(group, caughtUp))).toBe(true);
        expect(gate.stats().knownChunks).toBe(4);
        engine.dispose();
    });

    it('refuses a mask for a different grid rather than resizing', () => {
        const { gate, group, engine } = makeGate();
        const wrong: TerrainKnowledgeMask = {
            allyTeam: 0, chunksX: 4, chunksZ: 4, frame: 1,
            known: new Uint8Array(16).fill(1),
        };
        expect(gate.apply(wrong)).toBe(false);
        expect(gate.active).toBe(false);
        for (const m of group.allMeshes) expect(m.isEnabled()).toBe(true);
        engine.dispose();
    });

    it('answers the null-query rule in world coordinates', () => {
        const { gate, group, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        const known = new Array(n).fill(0); known[0] = 1;
        gate.apply(mask(group, known));
        const chunkWorld = group.plan.chunkQuads * 8;
        expect(gate.isPointKnown(10, 10)).toBe(true);
        expect(gate.isPointKnown(chunkWorld - 1, chunkWorld - 1)).toBe(true);
        expect(gate.isPointKnown(chunkWorld + 1, 10)).toBe(false);
        expect(gate.isPointKnown(10, chunkWorld + 1)).toBe(false);
        engine.dispose();
    });

    it('raises no curtain when the whole map is known', () => {
        const { gate, group, scene, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        gate.apply(mask(group, new Array(n).fill(1)));
        // Every chunk drawn, no frontier — the map rim is not a frontier.
        expect(gate.stats().knownChunks).toBe(n);
        expect(scene.getMeshByName('terrainFogCurtain')).toBeNull();
        for (const m of group.allMeshes) expect(m.isEnabled()).toBe(true);
        engine.dispose();
    });

    it('rebuilds one curtain per mask change, never accumulating meshes', () => {
        const { gate, group, scene, engine } = makeGate();
        const n = group.plan.chunksX * group.plan.chunksZ;
        const k = new Array(n).fill(0); k[0] = 1;
        gate.apply(mask(group, k));
        k[1] = 1; gate.apply(mask(group, k));
        k[2] = 1; gate.apply(mask(group, k));
        const curtains = scene.meshes.filter(
            (m) => m.name === 'terrainFogCurtain');
        expect(curtains.length).toBe(1);
        engine.dispose();
    });
});
