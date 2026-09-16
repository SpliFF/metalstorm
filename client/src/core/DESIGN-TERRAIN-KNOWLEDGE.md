# DESIGN — Terrain knowledge is LOS

**Status:** K0 (design + skeleton) landed; K0b closed the vertical slice on the server path (§12). K1+ implement *inside* this document.
**Arc directive:** user, 2026-08-30, recorded verbatim in the `terrain-streaming`
lane notes under "NEW ARC — TERRAIN KNOWLEDGE IS LOS". That entry is binding;
this document is its expansion, not its amendment. Where this document makes a
call the directive did not, it says so and gives the number behind the call.

---

## 0. The product statement

A player's knowledge of the terrain is limited to what their side has seen.

- Unknown ground **is not rendered at all**. The map is not a square. There is
  no "dark but present" terrain, no black tiles, no flattened placeholder
  geometry at the edge of knowledge.
- The reveal frontier is hidden under a **fog curtain** — a vertical, opaque
  layer standing on the boundary between known and unknown ground, so the
  player sees terrain, then fog, then nothing.
- The **server always keeps full terrain**. Sim, pathing, ballistics, damage,
  AI movement — all unchanged, all against the complete heightmap. This is a
  *knowledge* feature, not a simulation feature.
- **Intel and server-side AI-as-player are gated by the same mask.** A terrain
  query about a point the side has never seen returns NULL on every
  player-facing surface. The strategos explores under the same rules a human
  does; it is not handed the map.

Why, in the directive's own terms: the game is already built around reduced
visibility and reduced communication. Not knowing the terrain in advance is a
gameplay element — it forces exploration, and exploration uncovers unknown
risk. That is excitement and run-to-run variability, not a tech limitation.

**Second-order benefit, and the reason this arc is judged a winning
architecture independent of mega-maps:** nothing unknown is meshed, so the
"stitch visible geometry to invisible geometry" problem — the thing that makes
streamed terrain LOD hard — *dissolves*. There is no seam to hide because there
is no neighbour. The 8× map (mega-map geometry LOD) becomes a later step of
this arc rather than a prerequisite for it. **It is explicitly NOT K0.**

---

## 1. Where the knowledge lives: the per-ally ever-seen mask

### 1.1 Owner

The mask is **server-side, per ally team**, and it is the *only* authority on
what a side knows. The client holds a projection of it and nothing else; a
client that believes it knows a chunk it was not told about is a bug, not a
cheat vector, because the chunk's geometry never arrived.

It is **ever-seen, monotone, never cleared.** Once an ally team has had LOS
over a chunk, that chunk is known for the rest of the game. Losing LOS does not
unlearn terrain — see §6 (explored-but-stale).

### 1.2 What already exists, and what is new

The engine already carries a per-ally "explored" plane:
`IntelEventCollector::BuildLosBitmap` (`rts/Server/IntelEventCollector.cpp`)
keeps `exploredMaps[allyTeam]` and ORs `inLos` into it every second, then ships
it to the client as the third bit-plane of envelope `0x07`.

That plane is **not** the mask this arc needs, for three reasons, and K0 builds
a new structure *beside* it rather than reusing it:

1. **It is capped at 64×64** (`LOS_BITMAP_MAX_DIM`) and downsampled with OR, so
   on a 32 k-elmo map one bit covers 512 elmos and lights up from a single
   square of LOS. It is a minimap fog texture; it is deliberately optimistic.
2. **It is a side effect of a render feed.** It only advances when
   `BuildLosBitmap` runs, it resizes (and *clears*) whenever the LOS-map
   dimensions change, and it is not serialised anywhere.
3. **It is not at reveal granularity** (§2). The authoritative mask must be at
   exactly the granularity the wire reveals, or "known" and "meshed" can
   disagree.

The new structure is `TerrainKnowledge` (`rts/Server/TerrainKnowledge.h/.cpp`):
a per-ally bitset over the **terrain chunk grid**, with a per-ally revision
counter, and an `Update` that sweeps the same `losHandler` maps
`BuildLosBitmap` reads. It is deliberately a sibling of the intel collector,
not a field inside it, because the intel collector's output is a *display*
product and this is a *simulation-adjacent authority* product.

### 1.3 Size

The reveal grid is at most **8×8 = 64 chunks** on every map the client can
currently build (`MAX_CHUNKS_PER_AXIS = 8` in `terrain.ts`). So:

| quantity | value |
| --- | --- |
| mask, per ally team | **64 bits = 8 bytes** |
| mask, 16 ally teams | 128 bytes |
| reveal message on the wire | 8-byte header + 8 bytes = **16 bytes** |
| reveal message cadence | 1 Hz, same tick as the LOS bitmap |

This is the single most important number in the design. The mask is so small
that **every design question that would normally be a trade-off stops being
one**: we can send the *entire* mask every time instead of a delta, we can
snapshot it by value, we can keep one per ally team for free, and we can make
the message idempotent (§4.2) rather than incremental.

### 1.4 Snapshot / persistence

The mask must survive hibernate→resume and snapshot→restore, or a resumed game
hands every side a fresh, empty map and un-explores the whole match.

- It is **synced-relevant-by-proxy**: it is derived from `losHandler`, which is
  synced, but it is *historical* — it cannot be recomputed from the current LOS
  state, because "was ever seen" is not a function of "is seen now". Therefore
  it **must be serialised explicitly**, not recomputed on restore.
- Serialised form: `u8 allyTeamCount, u8 chunksX, u8 chunksZ`, then
  `allyTeamCount` packed planes of `ceil(chunksX*chunksZ/8)` bytes. Total for a
  16-team game: **131 bytes.** It costs nothing; there is no reason to make it
  clever.
- Placement: a section of `SimSnapshot` (`rts/Server/SimSnapshot.cpp`), which
  is the walk that `GameStateStore` gates on. **Adding a section changes the
  layout hash**, which is the intended behaviour — an old snapshot restored
  into a knowledge-enabled build must be refused loudly, not silently loaded
  with an empty mask.
- Chunk-grid mismatch on restore (`chunksX/chunksZ` differ from the map the
  server just planned) is an **E1-class refusal**, not a resize: a mask read at
  the wrong granularity is worse than no mask, because it is confidently wrong.

**Owned by K3.** K0 does not serialise the mask; a K0 resume starts the mask
empty and re-reveals from live LOS within one second, which is acceptable for a
skeleton and unacceptable for a shipped feature.

### 1.5 Late join / rejoin

A session that authenticates mid-game gets the full current mask on its first
`StreamTerrainKnowledge` tick — within one second — because the message is the
whole mask, not a delta. No join-time special case exists or is needed. This
falls out of §4.2 and is the second reason the message is idempotent.

---

## 2. Reveal granularity

**Default, and the K0 decision: the existing 128-quad terrain chunk.**
`planTerrainChunks` (`client/src/core/terrain.ts`) is unchanged.

### 2.1 Why the chunk

The chunk is the unit of *meshing*. A `TerrainChunk` is one `Mesh` (plus its
LOD1 and its skirts) built in one pass from one rectangle of the heightmap. The
client's "known" primitive has to be something the client can independently
exist-or-not, and today the smallest such thing is a chunk. Revealing at any
finer grain means building partial chunk geometry, which is exactly the
streamed-LOD problem this arc was supposed to dissolve. K0 does not reopen it.

### 2.2 The number that argues against it, stated plainly

On a standard 8192-elmo map (`mapx = 1024` squares, 1024 quads per axis):
`planTerrainChunks` gives `chunkQuads = 128`, `8×8` chunks, and a chunk is
`128 × SQUARE_SIZE(8) = ` **1024 elmos on a side**, area 1.05 M elmo².

Metalstorm sight distances (`data/games/metalstorm/units/`):

| unit class | `sightdistance` | LOS disc area | fraction of one chunk |
| --- | --- | --- | --- |
| civilian vehicle | 250 | 0.20 M | 19 % |
| line unit (typical) | ~450 | 0.64 M | 61 % |
| radar station L1 | 600 | 1.13 M | 108 % |
| carrier / radar L3 | 750–900 | 1.77–2.54 M | 169–242 % |

So one line unit that clips the corner of a chunk reveals **~1.6× more terrain
than it can actually see**, and a scout that merely enters a chunk reveals all
1024 elmos of it. On `pelagic_vastness` (32768 elmos) it is far worse: the plan
doubles `chunkQuads` to 512, so a chunk is **4096 elmos on a side** and a single
250-elmo civilian truck reveals a 16.8 M elmo² square — a **84× over-reveal**.

**Measured live on `meridian_basin`** (K0's slice map, 16384 elmos, `mapx =
2048`): the plan gives `chunkQuads = 256`, `8×8` chunks, and a chunk is
**2048 elmos on a side** — 4× the area of the 8 k example above. A 450-elmo
line unit that enters a chunk there reveals **6.5× more ground than it can
see**; the 250-elmo civilian truck reveals **21×**.

This is a real defect of the default, not a rounding error, and the design
records it rather than hiding it.

### 2.3 The amendment, and why it is not K0

The chunk count is capped at 8 per axis by `MAX_CHUNKS_PER_AXIS`, whose stated
reason (PLAN-maps.md §3) is the **draw-call guardrail**: ≤64 terrain draws at
whole-map zoom.

Knowledge mode **invalidates that guardrail's premise.** Whole-map zoom no
longer shows the whole map — it shows only known chunks, and on a large map
early in a game that is a handful. The structural cap on *drawn* chunks stops
being the grid size and starts being the knowledge mask's population count.

So the amendment is available and cheap: in knowledge mode, raise
`maxChunksPerAxis` (16 → 256 chunks of 512 elmos on an 8 k map; 32 → 1024
chunks of 1024 elmos on a 32 k map) and the over-reveal drops by 4× / 16×
respectively. The costs are real and must be measured before it lands: more
chunk meshes means more skirts, more index buffers, more `setEnabled` calls on
reveal, and a worse worst case if a side *does* eventually explore everything.

**Owned by K4 ("finer knowledge grid"), gated on a measurement, not a guess.**
K0 ships the chunk as-is so that nothing about the existing geometry path
changes and `terrain.test.ts` keeps its meaning.

### 2.4 What "seen" means for a chunk

A chunk is revealed when **any** square inside it is in the ally's LOS map.
Not radar, not air-LOS, not sonar — only true LOS. Radar tells you something is
*there*; it does not tell you what the ground looks like. This is a deliberate
divergence from the `0x07` bitmap's `inRadar` plane, which folds air-LOS in.

`GlobalLOS` (the `/globalLOS` debug verb and `set_los on`) reveals everything,
consistent with every other intel surface.

---

## 3. What rides the reveal

The directive requires **one reveal event**, carrying everything a client needs
to build that chunk:

1. **Heightmap chunk** — the corner heights for `[x0..x1] × [z0..z1]` inclusive.
2. **Typemap** — the same rectangle of the terrain-type map (movement /
   ground-property queries).
3. **Features** — every map feature whose footprint centre lies in the chunk.
4. **Ground-page authorisation** — the right to fetch the terrain texture pages
   covering the chunk's footprint (the existing `terrain-page-*` pyramid).

### 3.1 Why one event and not four

Because the client contract (§5) is "chunk built = known". If the height
arrives and the typemap does not, the client either meshes ground it cannot
answer queries about or holds unrendered data — both are states the contract
does not have a name for. One event, one transition, one invariant.

### 3.2 The split K0 actually makes

K0 ships the **authorisation**, not the payload. That is a deliberate
staging decision and it is the main thing this document asks a reviewer to
agree with:

- **The mask message (K0, built)** tells the client *which chunks it knows*.
- **The payload messages (K1)** carry the heights / typemap / features for a
  newly-known chunk.

The reason is that the client today already holds the whole heightmap (it
fetched `heightmap.bin` over HTTP before the game started — §7), so K0 can
prove the *entire* mechanism — mask → chunk visibility → fog curtain → live
reveal as a unit drives — without touching the map-delivery path at all. The
leak stays open for exactly one step and the skeleton is honest about it.

K1 closes it: the client stops fetching `heightmap.bin`, the heightmap arrives
per chunk on the reveal, and `buildTerrainMesh` becomes incremental.

### 3.3 Wire format (K0, implemented)

`ENVELOPE_TERRAIN_KNOWLEDGE = 0x0A`, on the `Vision` stream class beside the
LOS bitmap (a knowledge message must never head-of-line-block the control bidi):

```
u8  envelope = 0x0A
u8  allyTeam
u8  chunksX
u8  chunksZ
u32 frame                       (little-endian)
u8  bits[ceil(chunksX*chunksZ/8)]   MSB-first, row-major, z outer / x inner
```

K1 extends this with the payload as a second, chunk-addressed envelope rather
than growing this one: the mask is 16 bytes and ships every second; a chunk
payload is tens of kilobytes and ships once. Putting them in one message would
make the common case pay for the rare one.

---

## 4. The two wire traps this design is shaped around

### 4.1 In-game clients have no room SSE

There is no server→client event channel for an in-game client other than the
game stream itself. A reveal is therefore a **game-stream envelope**, streamed
from `StateStreamer` per session, ally-filtered exactly the way
`StreamLosBitmaps` is. It is not an SSE event, not an HTTP poll, and not a
FlatBuffers `ServerMessage` — it is a raw envelope, because it is a bitfield
and FlatBuffers would cost more in framing than the payload.

### 4.2 The entity lane is newest-wins — so the reveal is not an event

This is the constraint that shaped the message. The transport gives no
ordering and no delivery guarantee for a one-shot signal; a "chunk 3,4 was
revealed" message that is dropped, replayed, or reordered leaves the client
permanently wrong.

**Therefore there is no reveal event. There is a reveal *state*.**

The message carries the **entire current mask**, every time. It is:

- **Idempotent** — applying it twice is applying it once.
- **Reorder-tolerant** — the mask is monotone (bits only ever go 0→1), so
  applying an *older* mask after a newer one can only ever be a no-op if the
  client ORs rather than assigns. The client ORs. An out-of-order message
  cannot un-reveal a chunk.
- **Replay-tolerant** — a replayed message is a repeat of a state, not a
  repeat of a transition.
- **Self-healing** — a dropped message costs at most one second of latency,
  after which the next full mask arrives and the client catches up. No
  retransmit logic, no ACK, no sequence number.

At 16 bytes per second per session this is strictly cheaper than any delta
scheme would be, *and* it deletes the entire class of desync bug. This is the
design's best trade and it is only available because of §1.3.

### 4.3 A new wire message must be asserted at the FILE

A whitelist emitter silently drops keys it does not know. The envelope byte is
registered in **exactly two places** —
`rts/Server/Protocol.h` and `client/src/core/connection.ts` — plus a display
name in `client/src/core/net-inspector.ts`. K0's test therefore asserts the
**file contents**, not a runtime round-trip: `terrain-knowledge.test.ts` reads
`connection.ts` and `net-inspector.ts` off disk and fails if `0x0A` is absent
from either. A round-trip test would pass with the dispatcher arm deleted.

---

## 5. The client contract

> **A chunk that is built is known. A chunk that is absent is unknown.
> There is no third state.**

Everything else follows from that sentence.

### 5.1 Visibility, not geometry (K0)

K0 realises the contract with `mesh.setEnabled(false)` on unknown chunks, which
is a *stand-in* for the real contract: the geometry still exists, it just is not
drawn. This is correct for the skeleton and wrong for the feature — a built-but-
hidden chunk still cost the memory and still holds heights an inspector can
read. K1 makes absence real: unknown chunks are never constructed, and reveal
*creates* the mesh.

The contract is written so K1 is a narrowing, not a rewrite: nothing outside
`terrain-knowledge.ts` is allowed to ask "is this chunk enabled?" — callers ask
`isChunkKnown`, which K1 re-implements over mesh existence.

### 5.2 Skirt interaction

Chunk skirts are the vertical aprons dropped from each chunk edge to hide
T-junction cracks between differing LODs (`terrain.ts`, `SKIRT_*`). Under
knowledge they acquire a second job and one hazard:

- **Second job:** a known chunk beside an unknown one has a genuinely open
  edge, and its skirt is what stops the player seeing under the terrain into
  the void. The skirt stays, at every chunk, always — including on the
  single-mesh small-map path where it is currently skipped. *(K1: currently
  `skirt: !plan.single`; knowledge mode must force it true.)*
- **Hazard:** the skirt drops a fixed distance below the edge. At a knowledge
  frontier on a cliff edge the drop may be shorter than the cliff and the
  player sees under it. The fog curtain (§5.3) is what actually guarantees
  opacity; the skirt is the cheap first line. **K2** measures the worst-case
  frontier drop on `meridian_basin` and either deepens the skirt at frontier
  edges or makes the curtain skirt-independent.

### 5.3 The fog curtain

The curtain is a **vertical opaque band standing on every known↔unknown chunk
boundary**, tall enough to cover the frontier from any legal camera angle, and
rendered from both sides.

Properties the design fixes now:

- It is built from the **mask**, not from the camera — it changes only when the
  mask changes (a few times per game per player), never per frame.
- It is **one mesh for the whole frontier**, rebuilt on mask change, not one
  mesh per edge. A 64-chunk grid has at most 112 internal edges; rebuilding a
  ≤112-quad ribbon on a reveal is free.
- It does **not** extend around the map's outer boundary. The outer edge of a
  known chunk at the map edge is the map edge, and that is allowed to be open —
  it always was.
- It is **not** the LOS fog overlay (`minimap-fog` / the `0x07` overlay). That
  one darkens *known* ground the side cannot currently see. These are different
  layers answering different questions and they compose: known-and-visible,
  known-and-dark, unknown-and-absent.

K0 ships a **placeholder curtain**: a flat-shaded, unlit, fully opaque dark
band at fixed height. K2 owns the real one (gradient, depth-fade into the
terrain, height from the frontier's own max elevation, art direction).

### 5.4 The perf constraint

`entity` is the binding client phase. **The knowledge check must not add
per-entity per-frame work, and it does not add per-frame work at all.**

The whole client-side mechanism is:

- on a mask message whose bits differ from the held mask (a few times per game):
  toggle up to 64 meshes, rebuild one ribbon mesh;
- on every other frame: **nothing**.

There is no per-entity knowledge test, no per-frame mask read, and no shader
branch. Units are already visibility-filtered server-side by LOS; a unit the
player can see is by construction standing on ground the player knows, because
seeing the unit revealed the chunk. The two masks cannot disagree in the
direction that matters. *(They can disagree the other way — known ground with no
visible units — which is the normal case and costs nothing.)*

---

## 6. Explored-but-stale: remembered terrain is allowed to be WRONG

This is a deliberate design property, not a defect, and it is called out here
so nobody "fixes" it later.

Terrain deforms. Craters (`CBasicMapDamage`) and Lua terraforming both funnel
through `CReadMap::UpdateHeightMapSynced` and broadcast as envelope `0x09`
(`BroadcastHeightmapUpdates`). Today that patch is **broadcast to everyone
unfiltered**, and the comment in `heightmap-events.ts` says why: *"Terrain has
no fog of war, so the patch is not LOS-filtered."* This arc makes that sentence
false.

Under knowledge, the rule becomes:

| chunk state for this ally | deformation patch |
| --- | --- |
| never seen | **not sent** — it would reveal that something happened there |
| known, currently in LOS | sent, applied live |
| known, currently out of LOS | **not sent** — the client's remembered heights go stale |

The third row is the interesting one. A side that shelled a ridge, then
withdrew, then returns finds the ridge *as it remembered it* until a unit sees
it again. That is intel gameplay: your map is a memory, and memories are wrong.
A player who plans an approach around remembered cover can be wrong about the
cover. **This is the feature.**

Consequences the implementation must respect:

- Re-entering LOS over a stale chunk must **resync** it — the server re-sends
  the chunk's current heights, not just resumes patches, or the client stays
  wrong forever. A monotone mask cannot express "this chunk is stale", so a
  *separate* per-ally per-chunk `lastSyncedFrame` is needed. **K5.**
- Deformation inside a known-but-dark chunk must be *recorded* server-side as
  "this ally's copy is stale" at deformation time, not discovered at re-entry,
  or the re-sync is a full-chunk send every time LOS touches anything. **K5.**
- The sim is untouched. The server's heightmap is always current; only the
  per-ally *copy* is allowed to lag.

---

## 7. The null-query rule

> **Any player-facing query about a point whose chunk the asking side has never
> seen returns NULL** — not zero, not the map's minimum height, not a guess.
> NULL, distinguishable from "the ground is at height 0".

"Player-facing" means: anything a human player or an AI-as-player can reach.
It explicitly does **not** mean the sim. `CGround::GetHeightReal`, pathing,
ballistics, collision and the movement classes all keep reading the true
heightmap with no mask consulted, because they are the simulation, and the
simulation is not a player.

Surfaces, and what NULL means on each:

| surface | today | under the rule |
| --- | --- | --- |
| `Spring.GetGroundHeight(x,z)` (client LuaUI) | interpolates the client's full heightmap | `nil` for unknown ground |
| `Spring.GetGroundInfo` / `GetGroundNormal` | same | `nil` |
| `Spring.TestBuildOrder` / `Pos2BuildPos` | evaluates anywhere | refuses on unknown ground |
| NL census / query engine (`client/src/ui/native-ui/query-engine.ts`) | has no terrain surface yet | must be *born* knowledge-gated |
| strategos (`rts/Server/AI/AIScriptContext.cpp`) | `AI.getMapData(name)` reads the whole processed map JSON | must return only known regions |
| `AI.getMapSize` | full dims | **stays full** — the map's *extent* is not secret, its *content* is |

That last row is a deliberate line: a side knows how big the world is. It does
not know what is in it. Hiding the extent would break the minimap frame, the
camera bounds and every coordinate the NL layer speaks, for no gameplay gain.

Ownership: **K6** (Lua callins), **K7** (strategos + NL census).

---

## 8. Leak audit — every surface that ships full-map knowledge today

Each row has exactly one owning step. A row with no owner is how a feature like
this ships with a hole in it.

| # | surface | where | leak | owner |
| --- | --- | --- | --- | --- |
| L1 | **Heightmap ships whole, over public HTTP** | `client/src/core/map-data.ts:153` fetches `/api/maps/data/{mapId}/heightmap.bin`; route is served by `rts/lobby_main.cpp:1961` as **`RouteAuth::Public`** | The entire terrain of every map is downloadable by anyone, unauthenticated, before a game even starts. This is the arc's primary leak and it is not even session-scoped. | **K1** |
| L2 | **Typemap + metalmap ship whole** | same fetch block, `typemap.bin` / `metalmap.bin` | Ground types and every metal spot, map-wide. Metal spots drive the minimap overlay and mex placement. | **K1** |
| L3 | **Minimap thumbnail ships whole** | `minimapUrl` → `/api/maps/data/{mapId}/minimap.ktx2`, public | A single image of the complete terrain. Gating the mesh while shipping this is theatre. | **K2** |
| L4 | **Minimap fog is a darkener, not a gate** | `client/src/core/minimap.ts`, `minimap-fog.test.ts`, `GpMinimapLos` | The backdrop is the full map with unexplored areas *dimmed*. Under this arc the minimap must render nothing where the side has never been. | **K2** |
| L5 | **Map features ship whole** | `MapData` FlatBuffer `features[]` (`map-data.ts`), delivered on auth | Every tree, rock and wreck on the map, including in unexplored territory. Feature positions outline the terrain. | **K1** |
| L6 | **Heightmap deformation patches broadcast unfiltered** | `StateStreamer::BroadcastHeightmapUpdates`, envelope `0x09`; `heightmap-events.ts` header comment states the assumption | A patch arriving for never-seen ground tells the player that something is happening there — a free intel channel. | **K5** |
| L7 | **Terrain texture pages are fetched by grid coordinate** | `client/src/core/terrain-page-http.ts` | Page URLs are derived from map coords with no authorisation; a client can request any page. | **K1** |
| L8 | **`0x07` explored plane is optimistic and map-shaped** | `IntelEventCollector::BuildLosBitmap` | Not a leak of *terrain*, but it is the surface the minimap gates on, so L4 depends on reconciling it with the real mask. | **K2** |
| L9 | **Client Lua terrain callins read the full client heightmap** | `lua-spring-api.ts` `GetGroundHeight` / `GetGroundInfo` / `GetGroundNormal` / `TestBuildOrder` | A widget can read the whole map. Closes only once L1 closes *and* the callins null-gate. | **K6** |
| L10 | **`AI.getMapData` reads the processed map's data dir** | `rts/Server/AI/AIScriptContext.cpp:470` (`ReadSandboxedJson`) | Server-side AI-as-player gets regions, roads, civilians, metal — the whole map — as JSON. Directly contradicts "AI explores under the same rules". | **K7** |
| L11 | **NL census / query engine has no terrain surface yet** | `client/src/ui/native-ui/query-engine.ts`, `nl-context.ts` | Not currently leaking (verified: no terrain/height/elevation query exists). Listed so that when one is added it is born gated, not retrofitted. | **K7** |
| L12 | **Snapshot / resume has no mask** | `rts/Server/SimSnapshot.cpp` | A resumed game re-reveals from scratch. Not a leak — the opposite — but it makes the feature unshippable. | **K3** |

---

## 9. Step map

| step | scope | state |
| --- | --- | --- |
| **K0** | this document + working skeleton: server mask, `0x0A` wire, client chunk gate, placeholder curtain, flag | **done** |
| K1 | make absence real: per-chunk heightmap/typemap/feature/page payload on the reveal; stop the whole-map fetch. Closes L1, L2, L5, L7 | next |
| K2 | minimap gating + the real fog curtain. Closes L3, L4, L8 | |
| K3 | mask in `SimSnapshot`; layout-hash bump; E1 refusal on grid mismatch. Closes L12 | |
| K4 | finer knowledge grid (raise `maxChunksPerAxis` in knowledge mode), gated on a draw-call + build-time measurement (§2.3) | |
| K5 | explored-but-stale: per-ally per-chunk `lastSyncedFrame`, LOS-filtered `0x09`, re-entry resync. Closes L6 | |
| K6 | null-query rule for client Lua callins. Closes L9 | |
| K7 | null-query rule for strategos + NL census. Closes L10, L11 | |
| — | **mega-map geometry LOD (the 8× map)** — a later step of this arc, explicitly not K0–K7's business | deferred |

---

## 10. The flag

**Stock behaviour — the full map — is the default. Nothing regresses.**

The flag is **server-side only**, and this is a deliberate choice over a client
modoption:

- The server emits `0x0A` only when the modoption `terrainknowledge` is set.
- A client that never receives a `0x0A` message never enables the gate. Its
  terrain path is byte-for-byte what it is today.
- Therefore there is **no client-side default to get wrong**, and no ordering
  hazard between "modoptions arrive" and "terrain is built" — a real trap,
  since `buildTerrainMesh` runs at `game-processor.ts:884` and modoptions land
  at `:1948`.

Enable with `terrainknowledge=1` in the modoptions (read via
`CGameSetup::GetModOptions()`, the same path as
`standingorder_default_ttl_frames`).

A client debug handle — `window.__gp('__terrainKnowledge.only([[0,0],[1,0]])')`
/ `.reveal(cx,cz)` / `.all()` / `.stats()` — forces the gate on locally for
capture work without a server flag. It synthesises a 0x0A message rather than
reaching into the gate, so it drives the same code path the wire does.

---

## 11. K0 slice — what was measured

Live, on `meridian_basin` (16384 elmos, 2049² corners → 8×8 chunks of 256
quads, chunk = 2048 elmos), a fresh room on the player path (a newly
registered non-admin browser account, not a dev identity):

| observation | value |
| --- | --- |
| terrain meshes built | 128 (64 chunks × LOD0+LOD1) |
| gate state on a **stock** server | `active: false` — no 0x0A ever arrives, terrain path unchanged |
| drawn chunks, mask = 4 known | **4 of 64**; curtain built, 16 verts (4 quads) |
| drawn chunks after revealing one more | **5 of 64**; curtain 24 verts — the frontier moved |
| curtain at the map rim | **none** — the rim is not a knowledge frontier |
| cost of a mask change (5 chunks) | 12 ms, once |
| cost of a mask change (all 64) | 35 ms, once |
| `entity` phase p95, 5 chunks known | 0.400 ms |
| `entity` phase p95, 64 chunks known | 0.400 ms |
| `entity` phase mean | 0.2488 → 0.2570 ms (inside the 0.1 ms timer quantum) |
| `render` phase mean | 4.50 → 4.77 ms going 5 → 64 chunks — knowledge mode draws **fewer** |

The `entity` numbers are the point: there is no per-frame or per-entity
knowledge work to measure, because none exists. The only cost is the one-off
on a mask change, and it is bounded by the chunk count.

Screenshots: `.tasks/notes/assets/terrain-knowledge-k0/`. The frontier reads
as known ground → opaque grey curtain → void. **Two honest caveats visible in
them:** map features are still drawn beyond the frontier (leak L5, K1's to
close), and `meridian_basin`'s forest is dense enough that a player-height
frontier shot is obscured by trees — the legible captures are elevated.

## 12. K0b slice — the SERVER path, measured

Same map, same player path (fresh non-admin account `k0bscout`, role
`player`), but this time the gate was driven by a real `spring-server` built
from this branch and launched by a lane lobby — **not** by the
`__terrainKnowledge` debug handle, which was never called.

How the flag reached the sim, and the cheapest path that does: the room host
POSTs `/api/rooms/modoption` `{key:"terrainknowledge", value:"1"}` before
start (host-only, pre-game only, no key whitelist — `RoomManager::SetModOption`).
The lobby turns every room modoption into a `--modoption key=value` argv pair
for the spawned server, `server_main.cpp` feeds it to
`CGameSetup::SetModOption`, and `StreamTerrainKnowledge` reads it on its first
tick. No scenario manifest, no headless config, no lobby change needed. The
`/api/rooms/direct` manifest's `modoptions` object is the other route (dev-only).

Proof it was the server: the room's process was
`spring-server --room 2 … --modoption terrainknowledge=1`, its
`/api/metrics` `identity.engineHash` matched the on-disk lane binary
(`c9fd4aa7cc218050`), and `game-2.log` carries
`[terrain-knowledge] ON - 8x8 chunks of 256 quads, 3 ally team(s)`.
The client's net inspector counted the `0x0A` messages directly.

| observation (room 2, `meridian_basin`) | value |
| --- | --- |
| first `0x0A` arrives | frame 30 (the first 1 Hz tick), 16 bytes |
| spawn-only mask, because the server said so | **4 of 64** — chunks (0,0) (1,0) (0,1) (1,1); curtain 16 verts |
| scout `19462` ordered from (2220, 980) to (5200, 5300) | |
| reveal 1 — scout at (3749, 2133) | 5 chunks, revision 2, mask frame 1260 |
| reveal 2 — scout at (4381, 2818) | 6 chunks, revision 3, mask frame 1530 |
| reveal 3 — scout at (5136, 3731) | 7 chunks, revision 4, mask frame 1860 |
| reveal 4 — scout at (5633, 4081) | **9 chunks**, revision 5, mask frame 2010 |
| final known set | (0..1, 0..1) + (2,0) (2,1) (2,2) (3,1) (3,2); curtain 36 verts |
| `0x0A` messages received over the whole drive | **5**, 80 bytes total — one per revision |
| late join (page reload into room 1 at frame 9090, 8 chunks known) | first message carries the full 8-chunk mask; `revisions: 1` on the fresh client |

Two things the slice makes precise:

- **The streamer sends on revision change, not every second.** §1.3/§4.2
  describe "the entire mask, every second"; `StreamTerrainKnowledge` keeps a
  per-client `(allyTeam, revision)` stamp and skips when it is unchanged ("a
  bandwidth skip only"). Correctness is unchanged — the message is still the
  whole mask, still idempotent, and late join still gets everything on the
  first tick — but "self-healing after a drop within one second" only holds
  if the `Vision` stream class is reliable. If it is not, a dropped mask stays
  dropped until the next reveal. Worth one line of certainty in K1.
- **Reveal-on-touch, as designed.** The scout's 450-elmo sight revealed chunk
  (2,0) at x = 3749 — ~350 elmos short of the 4096 boundary — i.e. the chunk
  lit up the moment the LOS disc clipped it, and the whole 2048-elmo chunk came
  with it. That is the §2.2 over-reveal, now observed rather than computed.

Screenshots: `.tasks/notes/assets/terrain-knowledge-k0/k0b-server-before-drive.png`
and `k0b-server-after-drive.png` (same camera, frames 150 and 2790: the x = 4096
curtain wall is gone and the mountain behind it is meshed; the z = 4096 wall
still stands), `k0b-server-room1-frontier.png` (the 8-chunk block's south wall
from above: known ground → grey curtain → void). Features still draw beyond
the curtain (L5, K1's).
