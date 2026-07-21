# Meridian Basin — Layout Graph & Design Sketch

**Status:** design sketch (PLAN-metalstorm-beta-map.md **task 1**). This is the design-judgment
artifact that seeds the mechanical work: the generator (task 2), civilian/convoy data (task 3),
region validation (task 4), and the scenario file (task 5) all build against it.

**Canonical source:** [`tools/mapgen/meridian_layout.json`](../../tools/mapgen/meridian_layout.json).
That file is the *single source* the generator reads to build **both** the heightmap **and**
`mapdata/regions.lua`, so the map and its region graph can never disagree (beta-map §2). This
document is the human-readable companion — geography, diagram, rationale, and the mapping from
every region to the *system* it exists to showcase. Numbers here are quoted from the JSON; when
they differ, the JSON wins.

The map is a **systems showcase**: every backbone (regions, civilians, chokepoints, move-classes,
naval, correctly-scaled building) gets one region/feature where it runs at full strength, instead
of demoing at half strength on `green_flat` (§1). Nothing on it is decoration.

---

## 1. Geography at a glance

- **16384 × 16384 elmos**, 2 sides — **North** (blue, z < 8192) vs **South** (red, z > 8192) —
  mirrored across `z = 8192`. Up to 4 drop-in players per side.
- **The river is the front line.** It enters from the **west edge** into a deep channel, runs
  **east** along the contested middle band, **fords shallowly** across the three land crossings,
  and pools into a **lake** at the **east** before draining off-map. North bank and South bank can
  only meet by fording one of **three passes** — or by boat in the **two deep water pockets** that
  flank them. Two naval theatres, three land chokepoints, one central prize.
- **7 rows × ~3 columns = 24 regions**, tiling the whole playable area (no `wilds` gaps).

### Row structure (North → South)

| Row | z-band (elmo) | Role | Regions (W → E) |
|---|---|---|---|
| **A** home-N | 0 – 2400 | North home + industry | `cinder_forge` · `northgate` · `northwatch` |
| **B** mid-N | 2400 – 5400 | North population + spine | `ash_habitat` · `granary_vale` · `north_market` |
| **C** ridge-N | 5400 – 7200 | North approach / slope variety | `west_scarp_n` · `hollow_overlook_n` · `east_bluffs_n` |
| **D** contested | 7200 – 9184 | **The river band** | `west_narrows` · `west_pass` · `meridian_basin` · `east_pass` · `still_mere` (+ `heron_ait`) |
| **E** ridge-S | 9184 – 10984 | mirror of C | `west_scarp_s` · `gulch_overlook_s` · `east_bluffs_s` |
| **F** mid-S | 10984 – 13984 | mirror of B | `shale_habitat` · `sorghum_vale` · `south_market` |
| **G** home-S | 13984 – 16384 | mirror of A | `slag_forge` · `southgate` · `southwatch` |

### Node/edge diagram (schematic, +x east ▸, +z south ▼)

```
        x:0        3200      6400        9984       13184      16384
       ┌──────────────────┬───────────┬───────────────────────────┐
 z 0   │  CINDER FORGE     │ NORTHGATE │        NORTHWATCH          │  A  home-N
       │  ▓industrial▓     │  ⚑start   │        (radar knoll)       │  (BLUE)
 2400  ├──────────────┬────┴─────┬─────┴──────────┬────────────────┤
       │ ASH HABITAT ⌂│  GRANARY VALE  (VEH road) │ NORTH MARKET ⌂ │  B  mid-N
       │  ══convoy_north═════════●═══════════════════════════╗     │
 5400  ├──────────────┼────────────────┼──────────┴────────────────┤
       │ WEST SCARP  ▲│ HOLLOW OVERLOOK │        EAST BLUFFS        │  C  ridge-N
       │ (INF-only)   │  (VEH, HVY-lip) │   (HEAVY-restricted)      │
 7200  ├──────────┬───┴────┬───────────┼──────────┬────────────────┤
~~~~~~~│ WEST     │  WEST  │  MERIDIAN  │   EAST   │  STILL MERE     │  D  CONTESTED
 river │ NARROWS  │  PASS  │   BASIN    │   PASS   │  (lake)  ▪heron │  ← the river
~~~~~~~│ ≈deep≈   │ ‖ford‖ │ ‖‖ FORD ‖‖ │ ‖ford‖   │ ≈▒shore▒≈deep≈  │  (NEUTRAL)
 9184  ├──────────┴───┬────┴───────────┼──────────┴────────────────┤
       │ WEST SCARP  ▼│ GULCH OVERLOOK  │        EAST BLUFFS        │  E  ridge-S
10984  ├──────────────┼────────────────┼──────────┬────────────────┤
       │ SHALE HAB. ⌂ │  SORGHUM VALE   │ SOUTH MARKET ⌂           │  F  mid-S
       │  ══convoy_south══════════●══════════════════════════╝     │
13984  ├──────────────┴────┬─────┬─────┴──────────┬────────────────┤
       │  SLAG FORGE       │SOUTHGATE│        SOUTHWATCH          │  G  home-S
       │  ▓industrial▓     │  ⚑start │        (radar knoll)        │  (RED)
16384  └──────────────────┴─────────┴───────────────────────────┘

 ‖ford‖ = 44-elmo chokepoint deck (column mode)   ‖‖FORD‖‖ = 112-elmo basin crossing
 ▲/▼ INFANTRY-only ridge    ≈deep≈ naval channel    ▒shore▒ amphibious shallows    ▪ island
 The ONLY north↔south links cross row D: 3 land fords + 2 water pockets.
```

---

## 2. What each requirement maps to

Every §1 brief line has a concrete home on the map:

| §1 requirement | Where it lives | System it showcases |
|---|---|---|
| ~24 valued+tagged regions, full adjacency, no `wilds` | all 24 regions; bboxes tile the plane | region validator · AI strategic map · region-priced orders reading differently W↔E and home↔front |
| 4 civilian districts + 2 convoy routes | `ash_habitat`, `north_market`, `shale_habitat`, `south_market`; `convoy_north`/`convoy_south` along the vale spines | civilians · protect/escort/extract objective generation · estate protection contracts |
| Central contested basin flanked by two ridge corridors, chokes sized to formations | `meridian_basin` (value 2.5) + `west_pass`/`east_pass` (44-elmo decks) | control objectives · flow-field congestion · trail-follow column mode |
| One flat industrial plain per side | `cinder_forge` (N) / `slag_forge` (S), `flat` band, large footprints | scaled building families · factory showcase · **scale-4 assembly + underpass demo ground** |
| River/lake with a crossing + a deep channel | river spine across row D; `west_narrows` (channel) + `still_mere` (lake) + `heron_ait` (island) | naval/sub classes · amphibious move-class differentiation · bridges-as-chokepoints |
| Slope variety banded to move-class thresholds | scarps (INF-only) / overlooks (HEAVY-lip) / bluffs (HEAVY-restricted) / basin+plains (all) | passability grid + per-class flow behaviour visible in play |
| Start ≥ 2 region-hops from basin | `northgate`/`southgate` are **3 hops** from `meridian_basin` (verified) | early game = expansion through neutral regions, not instant contact |

---

## 3. Move-class banding (mirrors `moveinfo.tdf`)

The generator's slope-band pass matches the engine thresholds exactly, so the bands are
*guaranteed*, not eyeballed (this is what makes the E1 slope-consistency check meaningful).

| Band | slope (deg) | Passable | Blocked | On the map |
|---|---|---|---|---|
| `flat` | ≤ 24 | INFANTRY · VEH · HEAVY | — | industrial plains, basin floor, valley/convoy roads, ford decks |
| `veh` | 24 – 32 | INFANTRY · VEH | HEAVY | overlook lips, bluff pinches (**HEAVY-restricted**) |
| `infantry` | 32 – 45 | INFANTRY | VEH · HEAVY | scarp walls (**INFANTRY-only ridges**) |
| `cliff` | > 45 | — | all land | ridge crests / canyon walls framing the passes |

Water (mirrors `maxwaterdepth` / `minwaterdepth`):

| Band | depth (elmo) | Land wade | Naval | On the map |
|---|---|---|---|---|
| `ford` | ≤ 12 | INF · VEH · HEAVY | — | the three land crossings |
| `shallow` | 12 – 20 | VEH · HEAVY | SHIP | lake shores (INFANTRY blocked) |
| `deep` | 20 – 30 | HEAVY (at limit) | SHIP · SUB | mid-lake |
| `channel` | > 30 | — | SHIP · SUB | west narrows, lake deep center |

`still_mere` grades **shore → shallow → deep → channel** outward, so one lake demonstrates the
full amphibious ladder: INFANTRY stops at the waterline, VEH/HEAVY wade the shallows, ships sail
anywhere, subs own the deep — and `heron_ait` in the middle is a **land objective only naval or
amphibious play can take**.

---

## 4. Chokepoint sizing

Brief (§1): a corridor pinch must be **narrower than a deployed formation, wider than a column**,
so squads drop into flow/trail-follow **column mode**
([flow](../../PLAN-metalstorm-flow.md), [squad-pathfinding](../../PLAN-metalstorm-squad-pathfinding.md) §3).

- **Formation width** `W_form ≈ 2 × formation_radius`. Base `formation_radius = 24`
  (`units/_builder.lua`) → ~48 elmos, scaling `radius·√growth` to ~96 at scale 3.
- **Column width** `W_col ≈ member footprint + lateral jitter`. VEH `footprintx=2` → 16 → ~28;
  HEAVY `footprintx=4` → 32 → ~44.

| Feature | Region | Deck | Mouth | Effect |
|---|---|---|---|---|
| `west_ford_deck` | `west_pass` | **44** | 160 | HEAVY crosses single-file (col ≈ 44); no squad deploys abreast (< base formation 48) → column mode. INFANTRY may scramble the flanking scarps. |
| `east_ford_deck` | `east_pass` | **44** | 160 | Mirror; a shoulder of the `still_mere` lake, so ships/amphibs contest the crossing. |
| `basin_ford` | `meridian_basin` | **112** | 320 | Wider than a formation (~96) so mid squads hold — but multi-squad load makes the flow-field density term bite → **congestion** showcase. The most exposed crossing, hence the highest region value (2.5). |

---

## 5. Civilians & convoys

Four Gaia-populated districts, two per side, each tagged `civilian, habitat, transit`. Two
standing convoy routes run the lateral **vale spine** behind each front (`granary_vale` /
`sorghum_vale`, `flat` VEH roads):

- **`convoy_north`**: `ash_habitat` → `granary_vale` → `north_market` (z ≈ 3900)
- **`convoy_south`**: `shale_habitat` → `sorghum_vale` → `south_market` (z ≈ 12484)

The spines sit one row behind the ridge line, so a raid dropping down through `hollow_overlook_n`
/ `gulch_overlook_s` can threaten a convoy — the natural generator for **escort / protect /
extract** objectives, and the estate's protection contracts. Districts stay Gaia-populated
regardless of which side controls the region.

---

## 6. Scenario seed (feeds task 5)

Home + mid rows start owned; ridge rows and the whole contested band start **neutral**, so the
opening is expansion through neutral ground (start is 3 hops from the basin). Drop-in start slots
(4/side) spread across the home row — see `start_positions` in the JSON.

- **North owns:** `cinder_forge`, `northgate`, `northwatch`, `ash_habitat`, `granary_vale`, `north_market`
- **South owns:** the mirror (`slag_forge` … `south_market`)
- **Neutral:** all row-C/D/E regions (the ridges, the river band, the passes, the water, the island)

These keys are the ones `scenarios/meridian_basin.lua` must reference (its stub notes the keys
must exist in the map graph — they now do).

---

## 7. Verified invariants

Checked programmatically against the JSON (and re-checked by the task-4 validator + E1 extension):

- **24 regions**, bboxes tile `[0,16384]²` with **zero gaps** (no `wilds`) and zero non-island
  overlaps. `heron_ait` overlaps `still_mere` and is **declared first**, so it wins its footprint
  (§1.1 first-declared-wins).
- **Adjacency fully symmetric**; the graph is **connected** (all 24 reachable).
- **Start → basin = 3 hops** both sides (≥ 2 required).
- **All region values ≥ 0.**
- **Crossings only through row D** — the three land fords + two water pockets are the sole
  north↔south links, which is what makes the chokepoints load-bearing.

---

## 8. Open judgment calls for the hand-tune loop (task 2 → 6)

Deliberately left to the regenerate → fly-through → adjust loop (§2), not frozen here:

- **Exact deck widths (44 / 112).** The band math says "force column"; playtest confirms it
  against real squad radii once beta-units land. Tune in the JSON, regenerate.
- **`still_mere` depth gradient shape** — how wide the wadeable shelf is vs the sub channel; sets
  how much amphibious play the lake actually invites. Inert until ships/subs exist (E3).
- **Region *polygons* vs the bbox tiling here.** Rectangles guarantee coverage for the sketch; the
  generator may Voronoi-relax them toward the terrain (a scarp edge following the real ridge line)
  as long as coverage + adjacency + the E1 slope-consistency check stay green.
- **Radar-knoll placement** in `northwatch`/`southwatch` — cosmetic to the graph, matters for LOS.
