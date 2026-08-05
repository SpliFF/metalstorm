# DESIGN-GUIDE — what a Metalstorm model must look like

Distilled from `toolkit/extras/.../STYLE.md` (the authority — read it if this
page and it ever disagree) plus the worldbuilding register. Agent-optimised.

## The world in one line

Post-nuclear scavenger WW4: patched-up salvage, improvised armour, kinetic
weapons, rust and soot. Mad Max / Fallout adjacency — never clean sci-fi,
never lasers (emissive cyan is RESERVED for ancient technology).

## Silhouette first

Models are read at strategic zoom, mostly as impostors. Silhouette and flat
colour blocking carry the read; surface detail does not survive distance.
- Flat shading; colour by zone/swatch, no baked lighting or AO.
- Bevel rule: hard edges get a small chamfer (~2–4% of the piece's smallest
  dimension) so edges catch light. Skip slivers.
- Greeble budget: FUNCTIONAL only (vents, hatches, antennae, mounts), nothing
  under ~0.3 m. Test: if it doesn't change the silhouette or read as a
  functional part from 15 m, cut it.
- Weathering is a texture choice (rust streak, soot, grime), never geometry.

## Scale (dominant dimension, metres) — from STYLE.md

| Class | s1 | s2 | s3 | s4 |
|---|---|---|---|---|
| soldiers (height) | 1.8 | 1.85 | 1.9 | 2.1 |
| tanks (length) | 4.5 | 8.5 | 12 | 26 |
| artillery (length) | 4.5 | 7.5 | 10.5 | 15 |
| mechs (height) | 3 | 5 | 7.5 | 11 |
| fighters (span) | 6 | 9 | 12 | 16 |
| bombers (span) | 8 | 12 | 16 | 22 |
| ships (length) | 20 | 35 | 55 | 80 |
| subs (length) | 18 | 30 | 45 | 65 |
| static defense (height) | 3 | 4.5 | 6 | 8 |
| radar/mast (height) | 4 | 6 | 8 | 11 |

Buildings: metres = footprint cells × 2 (see STYLE.md table). A spec override
beats this table — honour the brief.

## Tri budgets

Infantry ≤800 (impostor-first) · vehicles/masts/props ≤2,000 · scale-4 hero
≤8,000 · buildings footprint-driven (stay lean; flat shading is cheap).
Textures: 1024² under 15 m dominant dim, 2048² at or above.

## Texture set & discipline

Five maps: diffuse, ORM, emissive, team, normals. Team colour lives ONLY in
the team mask R channel — banners, roundels, stripes, ID squares — never in
diffuse. Emissive: functional lights only (headlights, beacons, lit windows,
instrument glows); amber/warm for human tech; cyan strictly ancient-tech.

## Register (who made this thing?)

- **Player/faction hardware**: military pragmatism + field repairs. Mismatched
  plates OK, decorations functional (stowage, sandbags, aerials).
- **Archetype flavour** (dressing, naming, trim): Order = formal, numbered,
  uniform; Dynasty/Wealth = heraldic, gilt over worn steel; Resistance =
  improvised, camo nets, cause-marks; Anarchic = welded scrap, spikes,
  trophies.
- **Civilian estate**: corrugated iron, timber, tarps, hand-painted signs.
- **Ancient tech**: monolithic, segmented, seamless — wrong-angle geometry,
  cyan tracery, scorched surroundings. Nothing bolted, nothing patched.

## Naming

Defs/stems: `ms_<thing>[_s<scale>]` lowercase snake. Pieces: standard chains
(`turret/barrel/muzzle`), `axle_*`, `dish`, `flag`, `link*`. Clip names only
from: walk, idle, death, open, unload (or the spec's explicit list).
