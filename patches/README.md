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
