# `earth-equirect-1920.jpg` — the world-layer basemap

PLAN-worldsim.md W2. The world map is a map of Earth (PLAN-metalstorm-worldbuilding.md
Capture 10), and the projection choice is load-bearing rather than cosmetic:
this image is **equirectangular (plate carrée)** and **exactly 2:1**
(1920×960), which is what makes `lat/lon → pixel` the two divisions in
`client/src/lobby/world-map.ts` instead of a projection library. Replacing it
with any other image is fine *only* while both of those hold — a 1920×966 crop
would silently shear every POI toward the poles, and nothing in the code can
detect that.

- Source: NASA Earth Observatory / NASA Goddard Space Flight Center,
  "Whole world - land and oceans" (Blue Marble), via Wikimedia Commons:
  https://commons.wikimedia.org/wiki/File:Whole_world_-_land_and_oceans.jpg
- Licence: **public domain** (NASA imagery, no copyright).
- Provenance: the 1920px thumbnail of the 8192×4096 original, fetched
  2026-08-20. The original is 8192×4096; 1920×960 is the largest size the
  lobby has any use for (the screen zooms to 16× on a 2D canvas, and the map
  is decoration behind the POI graph, not the subject).

The screen degrades to a drawn graticule + ocean fill if this file is missing,
so a game that ships its own world can drop the asset without breaking the UI.
