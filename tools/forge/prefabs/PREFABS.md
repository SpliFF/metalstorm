# PREFABS — parts.py quick index

Import: `import parts as P` (PYTHONPATH via bin/env.sh). All functions write
into your meshlib.Part; zone params: Zone objects for box/face prefabs,
raw rects for limb-based ones (marked R). Piece-returning helpers give
gltf_export-ready dicts. Verified by prefabs/smoke_test.py.

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

Gaps to grow over time: track assemblies, hull lofts, gantry cranes, flags.
When you build a genuinely reusable assembly in a generator, note it in your
report so it can be promoted here.
