# Impostor LOD Implementation Design

**Task:** PLAN-metalstorm-beta-units.md B1 + task 4b — impostor render path + def wiring

**Coordination:** Interface compatible with PLAN-fx-offload.md X2 (data-texture substrate)

## Architecture

### 1. LOD Tier System

Three tiers per PLAN-metalstorm-beta-units.md §2.1:

| Tier | Representation | Renderer |
|------|---------------|----------|
| **Full** | 3D model, all pieces, thin-instanced per piece | EntityRenderer (existing) |
| **Impostor** | Camera-facing quad, atlas frame by heading×anim | ImpostorRenderer (new) |
| **Icon** | Strategic map symbol | Not rendered by EntityRenderer |

### 2. Per-Def Configuration

New fields in UnitDefInfo client-side (JSON from server):

```typescript
interface UnitDefInfo {
  // ... existing fields ...

  /** Impostor atlas metadata (optional — missing means no impostor tier). */
  impostor?: {
    /** Atlas diffuse+alpha URI, 8 cols × N rows. */
    diffuseUri: string;
    /** Team-mask atlas URI (R = blend). */
    teamMaskUri?: string;
    /** Number of walk-cycle frames (rows [0, walkFrames)). */
    walkFrames: number;
    /** Number of idle frames (rows [walkFrames, walkFrames+idleFrames)). */
    idleFrames: number;
    /** Quad size in elmos (derived from model bounds). */
    width: number;
    height: number;
  };

  /** LOD distance thresholds in elmos. */
  lodThresholds?: {
    /** Distance to switch Full → Impostor. */
    impostorDistance: number;
    /** Distance to switch Impostor → Icon. */
    iconDistance: number;
  };
}
```

**Server-side wiring:** `LuaDefsSerializer.inl` emits these fields from `customParams.impostor_*` (parsed from game Lua unit defs).

### 3. Render-Loop Integration

EntityRenderer.tick() flow:

```
for each visible entity:
  1. Determine LOD tier: determineLodTier(defId, worldPos, cameraPos, forceTier?)
  2. Switch on tier:
     - Full    → existing per-piece thin-instance path (unchanged)
     - Impostor → impostorRenderer.addInstance(...)
     - Icon    → skip (not rendered by EntityRenderer)
  3. After all entities: impostorRenderer.render()
```

**Key insight:** EntityRenderer already has a camera position (via scene.activeCamera) and can inject the LOD decision at the top of its per-entity loop (line ~2334 in the current code).

### 4. Coordination with fx-offload X2

Per-instance attributes for impostors:
- `heading` (float, quantized → atlas column 0–7)
- `animFrame` (float, atlas row index)
- `teamId` (float, for team-color shader)

**X2 compatibility:** These attributes use the **same naming and layout** as X2's planned animation-texture attributes for full models. When X2 lands, both paths can share:
- The same vertex shader inputs
- The same per-instance buffer layout
- The same animation-state logic in the JS animation system

**FIDELITY-STANDIN marker:** The impostor shader currently reads a fixed atlas frame (col 0, row 0) because per-instance custom attributes require `thinInstanceSetBuffer` support not yet wired. This is explicitly noted as a TODO for fx-offload X2.

### 5. Force-LOD Dropdown (Model Viewer)

The panel dropdown (panel.ts:221–231) already exists with disabled impostor/icon options. To wire it live:

1. Add `forceLodTier?: LodTier` to ModelViewerState
2. Wire dropdown onChange → `state.forceLodTier = selected`
3. Pass `state.forceLodTier` to EntityRenderer.tick() → determineLodTier(..., forceTier)
4. Enable the options: `['impostor', ..., true]` and `['icon', ..., true]`

### 6. Default LOD Thresholds

When a def has no `lodThresholds`, default behavior:
- `impostorDistance = Infinity` (never switch to impostor)
- `iconDistance = Infinity` (never switch to icon)
- Result: always render Full tier (backward-compatible)

### 7. Crossfade (Deferred)

PLAN-metalstorm-beta-units.md §2.1 mentions "crossfade over ~0.3s at the model↔impostor boundary so the swap doesn't pop". This is **deferred** from B1:
- Requires alpha-blending both tiers simultaneously during transition
- Needs hysteresis to avoid thrashing at the boundary
- Plan explicitly allows landing the tier system first, crossfade later

**Implementation note:** Add `// TODO(beta-units-crossfade): blend both tiers over 0.3s` where the tier decision happens.

### 8. Tests

Per PLAN-metalstorm-beta-units.md §8:
- Model loads → impostor mesh created
- determineLodTier() returns correct tier based on distance
- One draw call per (defId, team) impostor group (batching)
- Golden screenshot: strategic-zoom mixed-army shot (most units as impostors)

Vitest unit tests for:
- quantizeHeading(radians) → correct column 0–7
- LOD tier selection with various thresholds
- Impostor instance batching

## Implementation Steps (B1)

1. ✅ ImpostorRenderer class (impostor-renderer.ts)
2. ⏳ Modify EntityRenderer.tick() to inject LOD decision
3. ⏳ Wire ImpostorRenderer into game-processor.ts render loop
4. ⏳ Add impostor/lodThresholds fields to UnitDefInfo TypeScript types
5. ⏳ Server-side: emit impostor metadata in LuaDefsSerializer.inl (GameUnitDefs)
6. ⏳ Model-viewer: enable force-LOD dropdown + wire state
7. ⏳ Tests: Vitest + in-browser verification
8. ⏳ Document findings + update PLAN-metalstorm-beta-units.md

## Open Questions

1. **Atlas generation pipeline:** PLAN-metalstorm-beta-units.md §6 says "impostor bake (§2.1): headless Blender render → atlas layout". This is **out of scope for B1** — the impostor *renderer* lands now, the bake tooling is task 4b's Blender-CLI script (separate milestone).

2. **Default thresholds:** Should we auto-derive sensible defaults from model bounds? E.g. `impostorDistance = modelRadius * 50`? Or leave them as opt-in (Infinity default)?

   **Decision:** Opt-in for B1 (Infinity default). Metalstorm defs will author explicit thresholds; ZK/BAR get no impostors unless they add the config.

3. **Icon tier:** Is it rendered elsewhere (minimap, strategic overlay)? Or just "hidden" at far distances?

   **Answer (from plans):** PLAN-macro-map.md handles strategic zoom icons separately. EntityRenderer just hides Icon-tier entities (they're beyond gameplay interaction distance anyway).

## FIDELITY-STANDIN Markers

All explicitly noted per CLAUDE.md contract:

1. **Impostor shader:** Fixed atlas frame (col 0, row 0) until fx-offload X2 wires per-instance heading/animFrame attributes.
2. **Animation frame logic:** Always frame 0 (no velocity→gait-phase→walk-flipbook logic) until fx-offload X4 animation system lands.
3. **Atlas textures:** Placeholder grey material until beta-units task 4b lands the bake pipeline + authored atlases.

## File Checklist

- [x] `client/src/core/impostor-renderer.ts` (new)
- [ ] `client/src/core/entity-renderer.ts` (modify tick(), add determineLodTier integration)
- [ ] `client/src/core/game-processor.ts` (wire ImpostorRenderer)
- [ ] `client/src/core/connection.ts` (UnitDefInfo type extension)
- [ ] `client/src/scenarios/model-viewer/panel.ts` (enable dropdown)
- [ ] `client/src/scenarios/model-viewer/routines.ts` (wire forceLodTier state)
- [ ] `rts/Server/LuaDefsSerializer.inl` (emit impostor fields)
- [ ] `client/src/core/impostor-renderer.test.ts` (new, Vitest)
