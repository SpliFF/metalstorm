# Lane 1 — world-map review (2026-09-10)

## STATUS

complete (wrapped early) — coordinator directive; see "Not done".

Branch: `worktree-agent-a6e04ca095cbecba2` (cut from `main` at `88d257bce2`, merged `main` tip before starting).

## Findings (ranked)

| # | Sev | Where | What | Status |
|---|-----|-------|------|--------|
| 1 | HIGH | `world-map.ts` `drawEdges` (old L600–617) | An edge whose endpoints are more than 180° of longitude apart was drawn the LONG way round the plate carrée (Honolulu→Tokyo painted through Africa). On a strategic map that is a wrong fact about which places are adjacent, not a cosmetic slip. | FIXED `7fdba03f23` — `edgeSegments` splits at the antimeridian at the crossing latitude; test "splits Honolulu→Tokyo at the dateline". |
| 2 | HIGH | `world-map.ts` `fitScaleLabelThreshold = 1400` (old L688/702) | Label gate was an absolute px-per-map-unit. Any canvas wider than 2800 css px (a 4K lobby, or a 2× DPR 1440p) has a fit scale > 1400, so EVERY POI was labelled at fit zoom — the wall of overlapping text the threshold exists to prevent. Conversely a 640px-wide window never labelled anything below 4.4× zoom. | FIXED `7fdba03f23` — `labelsVisible(view, viewport)` is relative to the fit scale (`LABEL_ZOOM_FACTOR = 2`); pinned on 320px, 800px, 960px and 3840px canvases. `fitScaleLabelThreshold` kept exported, `@deprecated`. |
| 3 | MED | `world-map.ts` `drawPois` | Overlapping labels were all drawn (two POIs 4px apart at 2× zoom overprint). | FIXED `7fdba03f23` — greedy `placeLabels` by priority (selected > hovered > active > staging > owned > playable > region). |
| 4 | MED | `world-map.ts` `drawEdges` | `new Map(graph.pois…)` allocated on every paint (every mousemove that changes hover, every wheel notch). `poiOwnerColour` also evaluated twice per POI per frame. | FIXED `7fdba03f23` — `graphIndex(graph)` WeakMap cache (id index, transit range, both colour maps); one owner-colour lookup per POI. |
| 5 | MED | `world-map.ts` comments L503–507 vs code | Comment promised a "pulsing ring" for staging/active; nothing animated. | FIXED `7fdba03f23` — `DrawOptions.timeMs` drives an expanding, fading ring (`pulsePhase`, `PULSE_PERIOD_MS`); the static ring still draws without a clock, so a paused tab and the tests get a stable frame. |
| 6 | MED | `world-map.ts` `poiOwnedFallback` | Every unbadged owner (dissolved faction, badge that failed `#rrggbb`, pre-W7 lobby) painted the SAME lilac, so two such factions were indistinguishable. | FIXED `7fdba03f23` — deterministic per-id palette colour (`factionColour`), distinct per world (`assignFactionColours`). |
| 7 | LOW | `world-map.ts` `WorldCtx` | No dark outline on markers: an amber marker on Sahara sand / a light-blue one on Greenland ice vanished. | FIXED `7fdba03f23` — every glyph gets a 1px `poiOutline` stroke (white when hovered). |
| 8 | LOW | `world-screen.ts` (lane 2) L370–419 | Mouse events only: no touch/pinch, no keyboard (canvas is not focusable, no `tabindex`, no arrow/±/Home handling, no `aria-label`), tooltip innerHTML rewritten on every mousemove even when the text is unchanged. | PROPOSED — addressed in this lane by the new `WorldMap` controller (pointer events + pinch + keyboard + aria-live); world-screen.ts call-site change described under "API for lane 2". |
| 9 | LOW | `world-screen.ts` (lane 2) L183 | `open()` recomputes `fitView` on every `remount()` (every SSE room-list tick) — the player's pan/zoom is reset while they are reading the map. | PROPOSED (lane 2): only fit when the view is still the initial one (`scale === 1`) or the canvas size changed; the controller keeps its own `view` across re-wires. |
| 10 | INFO | `client/public/world/earth-equirect-1920.jpg` | Verified 1920×960, exactly 2:1 (`sips`). Unchanged. | OK |

## Changes

### `7fdba03f23` — drawing, palette, glyphs
- `client/src/lobby/world-map.ts`: `WorldLayers` + `DEFAULT_LAYERS` + `resolveLayers`; `WorldViewer`, `WorldClaim` + `parseWorldClaims` (open claims only); `graphIndex`; `factionColours` / `factionColour` (badge wins unless `safeColours`); `edgeSegments`; `edgeWeightCue` (log-scale width/alpha, fastest link boldest); `labelsVisible` / `placeLabels`; `pulsePhase`; `poiSummary` (chip contents: name, owner, state, ONE number — `Battle room #n` / `Lands in 6h` / `Transit links n`); `viewCentredOn` / `focusView` / `interpolateView` / `easeInOut`; `haloRadius` / `markerRadius`. Draw order: basemap → territory halos → edges → markers (glyph, "yours" dot, state ring, pulse, owner band, selection ring, claim pennant, commander star) → labels.
- `client/src/lobby/world-map-palette.ts`: `SAFE_PALETTE` (Okabe–Ito ×7 + Tol ×3), `hashId` (FNV-1a), `paletteColour`, `assignFactionColours` (sorted ids, hash slot, linear probe), `hexToRgb`, `withAlpha`, `relativeLuminance`, `contrastText`.
- `client/src/lobby/world-map-glyphs.ts`: `GlyphKind` (battleground ○, region ○ small, outpost △, depot ◇, foundry ⬡, relay ◆, port ⬠), `glyphKindFor` (unknown kind → mapId decides), `traceGlyph` / `traceClaimFlag` / `traceCommanderStar` (canvas), `glyphSvg` / `stateRingSvg` / `claimFlagSvg` / `commanderStarSvg` (legend) — one point table for both.
- Tests: `world-map.test.ts` 48 → 73, `world-map-palette.test.ts` 11, `world-map-glyphs.test.ts` 8.

## Proposed C++ patches (UNCOMPILED)

None. `GET /api/world/pois` and `GET /api/world/claims` carry everything the map draws.

## Out-of-lane findings

- `world-screen.ts` #8/#9 above.
- `client/src/ui/lobby/browser/browser.html` L185: the hint line "Drag to pan · scroll to zoom · click a marker for detail" is an always-on data-free caption; with the collapsed legend it can go (drill-down: the legend button carries the same information on demand).

## Assumptions / decisions

- POI `kind` vocabulary: the seeder emits only `region` / `battleground`; the preview fixture's richer kinds (outpost, depot, foundry, relay, waystation) are honoured as glyphs, and any unknown kind falls back on the `mapId` split rather than a "?" glyph.
- Faction badge colour WINS over the palette unless `layers.safeColours` is on — the palette is the accessibility switch and the fallback, not a replacement for a faction's chosen identity.
- Territory is a per-POI halo, not a Voronoi region: the world has no polygonal territory model, and inventing one client-side would draw borders the server never asserted.
- Only the EARLIEST open claim per POI gets a pennant (the tie-break rule the server applies); the chip carries the count.
- The pulse is off in a static frame (no `timeMs`) so the recording-ctx tests are deterministic.

### `caaa68ceb7` — `world-map-controller.ts` + `world-map.css` (tsc clean; NO unit tests yet — see Not done)
`WorldMap` class, the DOM half of the map. API for lane 2 (all backward compatible; `WorldScreen` is untouched and still works):

```ts
import { WorldMap } from './world-map-controller.js';
const map = new WorldMap(canvas, { basemapUrl?, overlayRoot?, layers?, hitRadius?, tools?, chip?, travelMs?, focusZoom? });
map.setGraph(graph); map.setViewer({ factionId, commanderPoiIds }); map.setClaims(parseWorldClaims(json));
map.setLayers({ territory:false }); map.getLayers();
map.select(poiId | null, { emit? }); map.getSelected(); map.activate(poiId);
map.focus(poiId, { animate?: true, zoom?, select? }); map.home({ animate? }); map.zoomBy(f, anchor?); map.panBy(dx, dy);
map.getView(); map.setView(v); map.resize(); map.redraw(); map.toggleLegend(open?); map.destroy();
const off = map.on('select' | 'hover' | 'activate' | 'view' | 'layers', handler);
// DOM events on the canvas (bubbling): 'poi-selected' {poiId, poi}, 'poi-activated' {poiId, poi}
```
Behaviour: pointer events (mouse + touch, pinch zoom), wheel zoom at cursor, drag threshold (4px) so a pan never selects, click = select + animated camera travel to 4× fit, double-click / Enter = `activate` (the drill), keyboard (arrows pan, +/− zoom, Home/0 fit, N/P step west→east through POIs, Esc clears, L legend), `tabindex`/`role=application`/`aria-label` on the canvas, `aria-live` announcer for selection, hover chip (name · owner swatch · state · one number · "your commander is here"), legend collapsed by default with glyph rows (SVG from the same point table), faction swatches, layer checkboxes and key hints, `⌂ Fit` button. Pulse rAF loop runs only while a staging/active POI exists, the tab is visible and the pulses layer is on. Stylesheet injected once (`#world-map-style`).

**Exact edit for lane 2 (`world-screen.ts`)** to adopt it, when the coordinator merges: in `wire()`, replace the wheel/mousedown/mousemove/mouseup/mouseleave/click listeners and the ResizeObserver with
`this.map = new WorldMap(c, { basemapUrl: this.deps.basemapUrl }); this.map.on('select', id => { this.selected = id ? this.graph.pois.find(p => p.id === id) ?? null : null; this.renderDetail(); });`
and in `refresh()` add `this.map?.setGraph(graph); this.map?.setViewer({ factionId: this.myFactionId, commanderPoiIds: this.stats?.commanders.map(c => c.poiId).filter(Boolean) ?? [] });`; `selectPoi(id)` becomes `this.map?.select(id); this.map?.focus(id)`; `#world-reset-btn` → `this.map?.home()`; `destroy()` → `this.map?.destroy()`. Drop `paint()`/`resize()`/tooltip methods. Optionally fetch `GET /api/world/claims` in `refresh()` and `setClaims(parseWorldClaims(json))`.

## Not done

- **Unit tests for `world-map-controller.ts`** (happy-dom: select/hover/activate events, keyboard, drag-threshold, legend toggle, chip text). The class typechecks and the full `src/lobby` vitest run is green (533/533), but the controller itself is untested. Highest priority follow-up.
- `world-preview.ts` `?v2` mode mounting `WorldMap` on the fixture (screenshot harness for the new chrome).
- Lane 2 call-site adoption (above) — proposal only, by design.
- Basemap layer variants (night lights / political) — not started.

## Next milestones

- Controller tests + preview `?v2` (above).
- Adopt `WorldMap` in `world-screen.ts` (lane 2) and delete its duplicated pointer code.
- Territory as real regions once the server asserts polygons (Voronoi over POIs is a client invention — do not).
- Edge kind styling (sea/road/air) once the seeder emits kinds other than `transit`.
- Basemap zoom pyramid (2 tiles at ≥4×) if the 1920px image reads blurry at 16×.
