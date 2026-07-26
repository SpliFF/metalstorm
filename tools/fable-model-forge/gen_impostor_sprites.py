"""gen_impostor_sprites — SUPERSEDED (PLAN-metalstorm-impostors M2).

The hand-authored single-frame billboard sprites this file used to paint are
gone: impostors are now baked FROM the 3D infantry bodies so the two can
never diverge (the plan's rule "3D model is the source of truth"). Use
`bake_impostors.py` instead — it renders an 8-yaw × 3-pitch directional
atlas off the generated meshlib geometry (see `impostor_convention.py`).

Kept only as a signpost; there is nothing to run here.
"""

raise SystemExit(
    "gen_impostor_sprites.py is superseded — run `python3 bake_impostors.py`.")
