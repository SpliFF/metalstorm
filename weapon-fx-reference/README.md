# Weapon-FX Phase V — ZK reference shots

This is the reference-image staging area for **Phase V** of the
weapon-FX work (the consolidated visual-parity audit in
[PLAN-weapon-fx-gaps.md](../PLAN-weapon-fx-gaps.md)).

We can't run Zero-K / Recoil locally (no working macOS build), so the
ZK side of the comparison comes from **online screenshots you source by
hand**. Each folder below identifies the ZK unit that fires one weapon
archetype, with Zero-K's own build-menu picture so you can recognise the
unit in a screenshot.

## The 11 archetypes

| # | Folder | Effect | ZK unit | Internal |
|---|---|---|---|---|
| 1 | `01-lasercannon`   | Laser cannon (moving bolt)        | **Bandit**     | `shieldraid` |
| 2 | `02-beamlaser`     | Beam laser (hit-scan)             | **Gremlin**    | `cloakaa` |
| 3 | `03-cannon`        | Ballistic plasma cannon           | **Big Bertha** | `staticheavyarty` |
| 4 | `04-starburst`     | Starburst ballistic missile       | **Impaler**    | `vehheavyarty` |
| 5 | `05-nuke`          | Nuclear ICBM + detonation         | **Trinity**    | `staticnuke` |
| 6 | `06-missile`       | Guided air-to-ground missile      | **Magpie**     | `bomberstrike` |
| 7 | `07-lightning`     | Lightning bolt arc                | **Felon**      | `shieldfelon` |
| 8 | `08-dgun`          | Disintegrator fireball (D-Gun)    | **Ultimatum**  | `striderantiheavy` |
| 9 | `09-flak`          | Flak airbursts (AA)               | **Thresher**   | `turretaaflak` |
| 10| `10-ground-to-air` | SAM anti-air missiles             | **Flail**      | `hoveraa` |
| 11| `11-air-to-air`    | Fighter cannon (air-to-air)       | **Swift**      | `planefighter` |

(A 12th archetype — naval / torpedo — is a scenario placeholder: the
test map has no water, so it's out of scope until a water map lands.)

## How to use this

1. Open a folder. Read `CARD.md` and look at the `unit_*.png`
   build-picture so you know what the unit looks like.
2. Find a Zero-K screenshot online showing that unit firing (search
   hints are in each card — usually `Zero-K <unit name>`).
3. Save it into the folder as `ref_<key>.png` (e.g.
   `01-lasercannon/ref_lasercannon.png`).

Once a folder has a `ref_*` image, I'll capture our engine's matching
shot via `?scenario=weapon-showcase&only=<key>`, drop it in as
`ours_<key>.png`, and fill the Phase V gap table
(archetype × {our shot, ZK shot, gap category}).

You don't need all 11 before I start — any folder with a reference image
is one I can validate. Folders without one, I'll still capture our shot +
the per-class LUPS coverage so the only thing missing is the side-by-side.
