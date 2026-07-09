# Option A asset audit — Quaternius / Kenney / OpenGameArt

PLAN-metalstorm-beta-units.md §3, Concrete task 3. Maps CC0/CC-BY/CC-BY-SA
packs from the three named sources to the §2 beta roster, before any
conversion work starts. Every entry below was fetched from the source's own
page (license quoted as stated there) — nothing is guessed. Style target:
flat-shaded low-poly, kinetic-sci-fi (autocannons/railguns/missiles, not
lasers), silhouette-first (art/STYLE.md).

## Coverage summary

Four slots are **well covered** with rigged/animated, CC0, pipeline-ready
candidates: **infantry** (Quaternius's Modular Men/Women packs ship literal
"SWAT"/"Soldier"/"Worker" characters), **mech** (Quaternius's Animated Mech
Pack has a confirmed named Walk cycle among 18+ animations — the single
strongest find of the whole audit, and reassuring since this is the one slot
that must be real rigged 3D), **fighter** (Quaternius Spaceships packs +
OGA's explicitly-modular "3D LowPoly Spaceships and Components"), and
**civilians** (Quaternius/Kenney/OGA all independently converge on strong
person + truck candidates). **Static defense** and **radar** are solid via
OGA specifically (Sci-Fi Rotary Turret and Sci-Fi Radio Dish Antenna, both
CC-BY 4.0 with confirmed separable pieces). Buildings split hard by
sub-type: **foundry** and **command-nexus HQ** are well served by Kenney's
City Kit (Industrial/Commercial) + Factory Kit; **habitat** is workable
(Quaternius LowPoly Buildings Pack); **transit hub** is a confirmed gap
everywhere. **Line tank** and **artillery** are the weakest vehicle slots —
usable candidates exist but piece separation (hull/turret/barrel/tracks) is
almost never confirmed from a source page alone; every candidate needs the
actual file opened before committing. **Scale-4 land dreadnought** is a
**confirmed universal gap** across all three sources — nothing with 2+
independently-rotatable turrets exists anywhere searched; this slot will
need custom kitbashing or generation (feeds Option B, out of this task's
scope). No NC/ND-licensed asset was found or considered anywhere in this
audit — every exclusion below is style/format/quality/completeness, not a
licensing violation.

## Roster slots

### 1. Infantry member (`ms_soldiers_s1`, `ms_engineers_s1`) — impostor-first per §2.1, 3D optional

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Ultimate Modular Men Pack** — [quaternius.com](https://quaternius.com/packs/ultimatemodularcharacters.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | Rigged+animated, 24 anims, 4 swappable parts | not stated | Named **"SWAT"** (soldier) + **"Worker"** (engineer) characters, in the same modular rig as civilians below — best single pick |
| **Ultimate Modular Women Pack** — [quaternius.com](https://quaternius.com/packs/ultimatemodularwomen.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | Rigged+animated, modular parts | not stated | Named **"Soldier"** + **"Worker"** characters |
| **Grunts + Riot Suppressor (low-poly)** — [OGA](https://opengameart.org/content/grunts-riot-suppressor-low-poly) | OGA | CC0 | .blend only | Rigged, "some basic animations" | ~1,100–1,300/char | 2 distinct variants (grunt + riot-suppressor) from one pack; kinetic sci-fi tone; needs a Blender export pass |
| **Exotrooper (low poly)** — [OGA](https://opengameart.org/content/exotrooper-low-poly) | OGA | CC0 | .blend only | Rigged, basic anims | 908 | Distinct exo-suit silhouette, same author/era as Grunts |
| **Blocky Characters** — [kenney.nl](https://kenney.nl/assets/blocky-characters) | Kenney | CC0 | FBX/OBJ/glTF | Rigged+animated, 18 skins/27 anims | not stated | No soldier-specific skin — best used as a rig/animation base for a custom reskin (police/mechanic skins closest) |
| Universal Base Characters — [quaternius.com](https://quaternius.com/packs/universalbasecharacters.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | Rigged, not pre-animated | avg 13k (stated) | Plain base body, no outfit — fallback rig only |

### 2. Line tank member (`ms_tanks_s2`) — hull+turret+barrel separable, tracks

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Halftrack** — [OGA](https://opengameart.org/content/halftrack) | OGA | CC-BY 3.0 (or CC-BY-SA/GPL, pick one) | .blend | static | ~40,000 | **Strongest confirmed piece separation** found for any tank: "separate meshes for main body, turret, barrels, wheels, tracks and tires" — but half-track (not fully tracked) and far over budget, needs heavy decimation |
| **Sci-fi Light Tank** — [OGA](https://opengameart.org/content/sci-fi-light-tank) | OGA | CC-BY-SA 3.0 (copyleft) | .blend | static, untextured | 2,460 (armed) / 1,168 (hull) | Turret+cannon confirmed on a separate layer; tracks vs. wheels unconfirmed |
| Animated Tanks Pack — [quaternius.com](https://quaternius.com/packs/animatedtanks.html) | Quaternius | CC0 | FBX/OBJ/Blend | animated | not stated | 4 tank models but piece separation entirely unconfirmed from any page reached |
| Heavy Tank [extra low poly, RTS] — [OGA](https://opengameart.org/content/heavy-tankextra-low-poly-rts) | OGA | CC0 | .blend/.glb | static | ~1,100 faces | Excellent budget + C&C-style silhouette, separation unconfirmed — open the file first |
| **Kenney: no 3D tank exists.** Confirmed via the site's own `tag:tank` filter — all four tank-tagged Kenney packs are 2D sprites. | Kenney | — | — | — | — | Gap |

### 3. Artillery member (`ms_artillery_s2`) — hull+gun separable, recoil-friendly

**Weakest vehicle slot across all three sources** — no candidate anywhere has *confirmed* separate hull+gun geometry.

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| Futuristic artillery turret — [OGA](https://opengameart.org/content/futuristic-artillery-turret) | OGA | CC0 | .blend | static, untextured | not stated | Best CC0 option on-theme; separation unconfirmed |
| Self Propelled Gun — [OGA](https://opengameart.org/content/self-propelled-gun) | OGA | GPL-2.0 (copyleft) | .blend | static | not stated | Thin documentation |
| Alien crawler vehicle — [OGA](https://opengameart.org/content/alien-crawler-vehicle) | OGA | CC-BY-SA 3.0/GPL (copyleft) | .blend | rigged, basic anims | 1,856 | Near-perfect concept ("planted mode" = stable artillery platform) but **explicitly a single fused mesh, no separable gun** — real dealbreaker as-is |
| Quaternius/Kenney | — | — | — | — | — | No dedicated SPG/howitzer pack found in either catalogue |

### 4. Mech (`ms_mechs_s3`) — rigged biped/quad walker, walk cycle

**Best-confirmed slot in the whole audit.**

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Animated Mech Pack** — [quaternius.com](https://quaternius.com/packs/animatedmech.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | Rigged+animated, **confirmed named clips: Walk, Run, Pickup, Death, Punch, Kick, Jump** (18+ total, per the pack's 2021 announcement) | not stated | 4 mech variants; strongest single find of the audit — real confirmed walk cycle, CC0, glTF-ready |
| Robot Enemy Pack — [OGA](https://opengameart.org/content/robot-enemy-pack) | OGA | CC0 | .blend | Rigged+animated: move/attack/idle/3×death | ~10,000 | 5 biped variants; "move" strongly implies locomotion, not explicitly named "walk" |
| Low Poly Robot — [OGA](https://opengameart.org/content/low-poly-robot) | OGA | CC0 | .blend | Rigged+animated: move/attack/damage/dead | 1,082 | Vertex-color only — excellent flat-shaded style match, tightest budget |
| Mechs 64x64 (sibling of "Mech") — [OGA](https://opengameart.org/content/mechs-64x64) | OGA | CC-BY-SA 3.0 + GPL 3.0 (copyleft) | .blend | rigged | 1,733 | Corroborated **"16 frames of the mech walking for all 8 directions"** — real walk cycle, fallback tier only for the license |
| Spiderbot 1.0 — [OGA](https://opengameart.org/content/spiderbot-10) | OGA | CC-BY-SA 3.0 (copyleft) | .blend | animated (unconfirmed clips) | not stated | Only quad/multi-leg (8-legged) candidate found anywhere — high risk, unverified gait |

### 5. Fighter (`ms_fighters_s2`) — single mesh + separable thruster/prop piece

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **3D LowPoly Spaceships and Components** — [OGA](https://opengameart.org/content/3d-lowpoly-spaceships-and-components) | OGA | CC0 | FBX ×3 (ships/components/accessories), .blend | static | not stated | **Best evidence of separable thruster geometry**: creator ships the ships *and* their component parts separately for reassembly |
| Ultimate Spaceships Pack — [quaternius.com](https://quaternius.com/packs/ultimatespaceships.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | static | not stated | 10 designs × 5 colour variants; thruster separation unconfirmed |
| Space Kit — [kenney.nl](https://kenney.nl/assets/space-kit) | Kenney | CC0 | not stated | static | not stated | Several fighter silhouettes among 150 files, on-palette (white/grey/orange); separation unconfirmed |
| LowPoly Spaceships Pack — [OGA](https://opengameart.org/content/lowpoly-spaceships-pack) | OGA | CC0 | FBX/OBJ/**glTF**/Blend | static | not stated | Best format coverage of any fighter candidate |

### 6. Static defense (`ms_staticdefense_s2`) — base+turret, emplaced

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Sci-Fi Rotary Turret** — [OGA](https://opengameart.org/content/sci-fi-rotary-turret) | OGA | CC-BY 4.0 | .blend, .glb | static, PBR-textured | not stated | **Confirmed** separate aimable barrel; explicitly "intended to be placed on a spaceship or base" — top pick |
| Cyberpunk Game Kit (turrets) — [quaternius.com](https://quaternius.com/packs/cyberpunkgamekit.html) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | static | not stated | Turret Gun ×2/Turret Cannon/Turret Teleporter, "separate base and gun components visible" per its bundle listing |
| polygon TD turret collection — [OGA](https://opengameart.org/content/polygon-td-turret-collection-0) | OGA | CC0 | raw/untextured | static | not stated | **Confirmed** separate base+turret; 6 weapon heads (4/6 kinetic-styled) |
| Heavy turret — [OGA](https://opengameart.org/content/heavy-turret) | OGA | CC-BY 3.0 | .blend | rigged | not stated | Rigged base/turret articulation |
| Tower Defense Kit (Kenney/OGA) | Kenney/OGA | CC0 | FBX/OBJ/glTF | static | not stated | Piece separation confirmed but **fantasy/medieval style clash** — do not use without a full re-skin |

### 7. Radar (`ms_radar_s1`) — base+dish, dish separate/spinning

**Best-served slot via OGA specifically.**

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Sci-Fi Radio Dish Antenna** — [OGA](https://opengameart.org/content/sci-fi-radio-dish-antenna) | OGA | CC-BY 4.0 | .blend, .glb | static, PBR-textured | not stated | **Exact match**: "made up of multiple parts, so the dish can be rotated to any angle," includes a team-colour mask already |
| Sensor/radar tower — [OGA](https://opengameart.org/content/sensorradar-tower) | OGA | CC-BY 3.0 | untextured | static | 1,092 faces | Abstract greeble silhouette, dish separation unconfirmed |
| Roof Radar / Roof Antenna (Ultimate Space Kit) — [quaternius.com](https://quaternius.com/packs/ultimatespacekit.html) | Quaternius | CC0 | FBX/glTF | static | not stated | Small rooftop-prop scale, not a station-scale installation — weak |
| Kenney | — | — | — | — | — | Confirmed absent, no dish/antenna asset anywhere in the catalogue |

### 8. Scale-4 hero — land dreadnought (`ms_tanks_s4`) — multi-piece, 2+ independent turrets

**Confirmed universal gap.** No pack across Quaternius, Kenney, or a dedicated OGA advanced-art search for "dreadnought" (1 irrelevant hit) produced anything with two or more simultaneously-mounted, independently-rotatable turrets on one ground vehicle. Closest analogs, all disqualified:

| Pack | Source | License | Why it fails |
|---|---|---|---|
| Sci-fi Light Tank — [OGA](https://opengameart.org/content/sci-fi-light-tank) | OGA | CC-BY-SA 3.0 | 1 real turret + fixed hull-mounted gatling guns (not independently rotating), also light-scale not hero-scale |
| Military Van — [OGA](https://opengameart.org/content/military-van) | OGA | CC-BY-SA 3.0/GPL | 7 *alternative* turret options for one mount point (swap, not simultaneous multi-mount) |
| Mobile Turret — [OGA](https://opengameart.org/content/mobile-turret) | OGA | multi (CC-BY/CC-BY-SA/GPL) | Only 1 turret, on a walker chassis, not a wheeled/tracked vehicle |

**Recommendation:** kitbash a standalone turret asset (e.g. Sci-Fi Rotary Turret above, used twice) onto a heavy hull (e.g. Heavy Tank [extra low poly, RTS]), or treat as a custom-build/generation slot — this is exactly the class of problem Option B's PoC (out of this task's scope) is meant to probe.

### 9. Civilians — person + truck

**Strongest-covered slot — all three sources converge independently.**

| Pack | Source | License | Format | Rig/Anim | Tris | Fit |
|---|---|---|---|---|---|---|
| **Animated Human Low Poly** (Quaternius, OGA mirror) — [OGA](https://opengameart.org/content/animated-human-low-poly) | OGA | CC0 | not fully itemized | Rigged+animated: idle/jump/punch/run/walk/work/death | not stated | Best style match — flat-shaded Quaternius house style, "work" anim ideal for a civilian |
| Ultimate Modular Men/Women Packs (civilian variants: Business Man, Farmer, Casual, Suit) | Quaternius | CC0 | FBX/OBJ/glTF/Blend | Rigged+animated | not stated | Same rig family as infantry — visual consistency between civilians and soldiers |
| **Mini Characters** — [kenney.nl](https://kenney.nl/assets/mini-characters) | Kenney | CC0 | not stated | Rigged+animated | not stated | Diverse unarmed civilian population, chibi proportions |
| **Free Low Poly Vehicles Pack** — [OGA](https://opengameart.org/content/free-low-poly-vehicles-pack) | OGA | CC0 | not itemized | static, wheels separated | not stated | Pickup + Truck + Truck-with-trailer + Monster Truck, material-separated for team recolor |
| **Car Kit** — [kenney.nl](https://kenney.nl/assets/car-kit) | Kenney | CC0 | not stated | static | not stated | Fire truck, cargo van, ambulance, 2× pickup trucks, farm tractor — excellent civilian-vehicle coverage |
| Truck / Pickup Truck / Pickup Truck Armored (Zombie Apocalypse Kit) — [quaternius.com](https://quaternius.com/packs/zombieapocalypsekit.html) | Quaternius | CC0 (a Sketchfab mirror shows CC-BY 4.0 — treat quaternius.com as authoritative, re-verify on download) | FBX/OBJ/glTF/Blend | static | not stated | Confirmed via individually-dated Poly Pizza listings matching the kit's release |

### 10. Buildings — nexus (HQ), foundry, habitat, transit hub

| Sub-type | Best pick | Source | License | Fit |
|---|---|---|---|---|
| **Foundry** | **Factory Kit** + **City Kit (Industrial)** | Kenney | CC0 | Excellent: pipes/conveyors/silos/factory shells, industrial blue-purple palette, flat-shaded low-poly, glTF-ready |
| **Command-nexus HQ** | **City Kit (Commercial)** | Kenney | CC0 | Modern skyscrapers/office towers, multiple height/colour variants — best available large-silhouette candidate, needs a sci-fi-military recolor pass |
| **Habitat** | **LowPoly Buildings Pack** (Quaternius "Ultimate Textured Building Pack") | quaternius.com (mirror on OGA) | CC0 | FBX/OBJ/Blend, modular, palette-atlas recolorable, close style match; individual buildings read modestly-scaled — select the tallest variants |
| **Habitat (big-tower option)** | Low-poly Skyscraper | OGA | CC-BY-SA 3.0 (copyleft) | 150 tris, reads as "big" at strategic zoom, single design only |
| **Transit hub** | — **confirmed gap, no source** — | — | — | Extensive search (station/terminal/depot/spaceport across all 3 sources) found no standalone 3D station building. Closest: Rail Basic assets v1 (OGA, CC-BY 3.0) has a platform + train + track kit but no station structure. Will need a custom build, likely from Kenney's City Kit (Roads) + Train Kit dressed with a City Kit Commercial building as the terminal shell. |

Runner-up building candidates: **Warehouse building, low poly** (OGA, CC0, ships as `.glb` directly — a direct pipeline-format match for foundry variety); **alien-building/base set** (OGA, CC0, modular kit-of-parts, needs assembly for HQ); Quaternius's **Ultimate Space Kit** "Base Large"/"Building L"/"Geodesic Dome" (CC0, promisingly named but scale unverified).

## Gaps (no CC0/CC-BY 3D candidate found — fall to Option B or the WZ2100 fallback)

- **Scale-4 land dreadnought** (slot 8) — universal gap, all three sources. Needs kitbash or generation.
- **Transit hub** (slot 10d) — universal gap, all three sources. Needs a custom build from infrastructure parts.
- **Artillery** (slot 3) — no *confirmed* separable hull+gun candidate anywhere; best options need the source `.blend` opened and verified (or reworked) before committing.
- **Radar** — well-served by OGA (Sci-Fi Radio Dish Antenna), but a **confirmed gap** in both Quaternius and Kenney individually — flagged so the single-source dependency is visible.
- **Line tank tracks** — no candidate has *confirmed* full (non-half) tracks; Halftrack's confirmed piece separation comes with a half-track mismatch, everything else is unconfirmed or wheeled.

## Licensing notes

- No NC/ND-licensed or "personal use" asset was encountered or considered anywhere in this audit, on any of the three sources — every exclusion above is a style, format (2D vs. 3D), or completeness reason, never a licensing one.
- Quaternius pages are consistently CC0 ("Creative Commons Zero"/Public Domain, no attribution required) — but two Sketchfab *mirrors* (Zombie Apocalypse Kit, Ultimate Space Kit) list "CC Attribution 4.0" on the Sketchfab listing itself, likely a platform default rather than the asset's real license. **Treat quaternius.com's own pack page as authoritative**; re-verify the license string on the actual downloaded archive before it gets an ASSETS.md row.
- OGA hosts mixed licensing per item (unlike Quaternius/Kenney's site-wide CC0) — every OGA entry above was verified on its own individual submission page, not inferred from a category listing.
- Several OGA candidates carry copyleft licenses (CC-BY-SA / GPL-2.0 / GPL-3.0) — usable per §1's policy but flagged explicitly above as "(copyleft)" wherever they appear, consistent with the "CC0 first where equivalent quality exists" preference.
- A handful of thematically ideal OGA finds are **2D-only** (Orange HQ/Manufactory/Barracks isometric series, Sci-Fi Top Down Shipyard Space Station, various pixel-art tank/turret packs) — Metalstorm's pipeline is glTF/`.glb` 3D (PLAN-metalstorm.md §9), so these are usable only as art-direction references or impostor-atlas source material (§2.1), never as a 3D-model source despite otherwise-permissive licenses.
