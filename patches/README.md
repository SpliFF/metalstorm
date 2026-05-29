# Vendored content patches

Patches in this directory are applied on top of game/engine content that
lives in untracked trees (`content/games/<id>/`, `data/games/<id>/`).
Used to keep a local fix in place after a fresh vendor drop without
hand-editing the files again.

## Files

- **zk-suspension-clamp.patch** — clamps the `ztilt`/`xtilt` integrator
  in ZK's wheeled-vehicle suspension scripts so it can't escape the
  small-angle basin and converge on the ±π upside-down equilibrium.
  Affected scripts: `vehraid`, `vehassault`, `vehsupport`, `vehaa`,
  `vehriot`. See script comments for the bug explanation. Engine-side
  root cause (why our piece-position feedback diverges from Recoil's
  on the same script) is a separate follow-up.
- **zk-tooltip-fallback.patch** — makes the cursor-tip widget
  (`gui_chili_selections_and_cursortip.lua`) consult
  `widgetHandler:GetTooltip(x, y)` as a fallback when no chili control
  supplied a tooltip. Stock Spring's engine polls `widgetHandler:GetTooltip`
  every frame; the web client has no engine tooltip renderer, so
  widget-provided tooltips (nuke button, transport, gesture menu, unit
  groups, …) never appeared. Computed fresh each call, so there is no
  staleness when the cursor leaves an element.

- **zk-web-graphics-settings.patch** — adds the web client's graphics
  options panel (`gui_web_graphics_settings.lua`, a Chili window with
  shadow-resolution / shadow-filtering / MSAA / FXAA controls + a quality
  preset) and repoints ZK's "Edit Main Graphics Settings" button
  (`gui_simple_settings.lua`) to open it via `WG.OpenGraphicsPanel`
  instead of the no-op `Spring.SendLuaMenuMsg("openSettingsTab Graphics")`
  (which targets the native Recoil launcher we don't have). Every control
  reads/writes through `Spring.GetConfigInt`/`SetConfigInt`, which on the
  web client land in the main-thread `ClientSettings` store; scene
  lighting subscribes to the keys and applies them. See PLAN-settings.md
  §6. The widget file is added to **both** `content/` and `data/` because
  the content→data mirror below only copies files whose `data/` target
  already exists.

## Apply / re-apply

```sh
patches/apply.sh                  # apply all *.patch to content/ and data/
patches/apply.sh --check          # dry-run, report what would change
patches/apply.sh zk-suspension-clamp.patch   # apply just one
```

The applier is idempotent: it skips hunks already present. Run it after
fetching new game content into `content/games/<id>/`.

## Adding a new patch

1. Edit the files under `content/games/<id>/` directly.
2. `diff -u <upstream> <patched> > patches/<name>.patch` using the
   `a/content/games/<id>/...` / `b/content/games/<id>/...` label form
   (relative to repo root) so `patch -p1` applies cleanly.
3. Document the patch's purpose in this README.
