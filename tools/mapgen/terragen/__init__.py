"""terragen — realistic procedural terrain generation for Spring RTS Web maps.

Pure-numpy, deterministic from a seed. Stages live in their own modules:

  noise      seeded simplex noise, fBm, ridged multifractal, domain warping
  hydrology  depression filling (priority-flood), D8 flow, accumulation
  rivers     slope-area channels, meandering centrelines, distance-field carve
  erosion    fluvial (stream-power) + thermal erosion
  biomes     temperature/moisture fields -> biome classification masks
  roads      least-cost road networks between settlements
  settle     settlement / town placement scoring

The top-level generator scripts (e.g. meridian2.py) compose these into a map
package. Everything here is data-in/data-out on numpy arrays; no file I/O.
"""
