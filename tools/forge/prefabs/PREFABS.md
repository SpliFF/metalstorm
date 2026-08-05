# PREFABS — parts.py (geometry) + paintlib.py (painting) quick index

Import: `import parts as P` / `import paintlib as PL` (PYTHONPATH via
bin/env.sh). parts functions write into your meshlib.Part; zone params: Zone
objects for box/face prefabs, raw rects for limb-based ones (marked R).
Piece-returning helpers give gltf_export-ready dicts. Verified by
prefabs/smoke_test.py.

## parts.py — geometry

- quad_out(p, verts, outward, zone) — quad wound toward `outward`
- box6(p, center, size, zone, ch, skip) — chamfer_box, ONE zone on all faces
- wheel / wheel_pair(center|y,z, r, w, zone) — n-gon wheels, axis X
- axle_piece(name, z_off, y, …) → spinnable piece DICT (engine spins X)
- lattice_tower(p, base_y, top_y, half_base, half_top, …) [R] — legs+X-bracing
- ladder(p, base, top) [R] · railing(p, a, b) [R] · stairs(p, base, top)
- crate / crate_stack(origin, rows, cols, tiers, rng=seeded)
- drum / drum_row · tank_cylinder(center, r, h) — domed storage tank
- tarp_over(center, (w,h,d)) — lashed-canvas read
- pipe_run(points) [R] · sandbag_wall(a, b) · antenna(base) [R] · beacon(center)
- turret_parts(body_index, mount, ring_r, barrel_len, twin=) → [turret,
  barrel, muzzle] piece DICTS; append contiguously and fix the two parent
  indices (docstring shows the 4 lines).

## paintlib.py — painting (over toolkit paint/weathering/normals)

- zone_fns(zone) → (u, v) world→atlas-px closures for the zone's two axes
- nbox(x0,y0,x1,y1) — order-normalised rect (flipped-u zones) · font(size)
- team_panel(m, box, outline=) — team-mask R + TEAMGREY diffuse respray
- glass_rect(m, box, outline=) · headlight / taillight(m, box, on=True)
- hazard_band(m, box) — yellow/black chevrons
- wheel_cell(m, rect) / hub_cell(m, rect, spokes, lugs) — tyre + hub atlas cells
- panel_patchwork(m, box, palette, cols, rows) — mismatched scrap plates
- roundel_star(m, cx, cy, r, col) — stencil star
- standard_weather(m, L, ground_rects, side_zones) → Weather (add extras, then
  pass to finish) · finish(m, L, stem, hm=, wx=) — weathers, writes ALL FIVE
  maps incl. normals (no save boilerplate in your painter)

Gaps to grow over time: track assemblies, hull lofts, gantry cranes, flags.
When you build a genuinely reusable assembly in a generator, note it in your
report so it can be promoted here.
