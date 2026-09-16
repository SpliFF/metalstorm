# tools/audiogen — audio sourcing/mix pipeline

Builds every file under `data/games/metalstorm/sounds/**` from
`manifest.json`. Every entry is rendered before it needs a manual asset
drop, and every entry gets an `ASSETS.md` row (via `write_assets_md`)
**before** its file is written — never the other way round.

## TOOLING GAP

The brief asks for "ffmpeg+sox". `sox` is not installed on this machine and
installing packages is outside this lane's scope — worked around with
**ffmpeg only**: every synthesis primitive (noise/tone/sweep generation,
trim, layer/mix, EQ, envelope, resample) has a direct ffmpeg filtergraph
equivalent (`synth.py`), so nothing here is a stand-in for missing
functionality.

`pytest` is also broken in this environment (`/usr/local/bin/pytest`'s
shebang points at a python3.7 that no longer exists) — `test_manifest.py`
is plain `unittest`, run directly: `python3 tools/audiogen/test_manifest.py`.

## Sourcing decision

No Sonniss GDC bundle was present at
`/Users/shannon/WarriorHut/Projects/assets/audio/sonniss/GDC2021-2023/` as
of 2026-09-17, and there is no reliable, licence-safe way to script
freesound/Kenney downloads without either an API key (freesound) or
guessing at asset URLs (Kenney) — both were judged too risky for a
sourcing pipeline whose entire point is licence hygiene. Every sound in
this pass is instead **self-authored layered synthesis** (the explicit
"meanwhile" fallback in the brief): ffmpeg-generated noise/tone/sweep
layers mixed per `recipes.py`, licensed `Original (Metalstorm project,
tools/audiogen layered synthesis)` — unambiguously clean, and matches
`client/src/core/assets-manifest.ts`'s existing `Original` licence class.

`manifest.json`'s `reserved_sonniss` list carries a row per named Sonniss
pack from the brief (24 packs) so `ASSETS.md` already has the paper trail
reserved; fill in real `Asset (path in tree)` + `Origin (URL)` once a pack
is downloaded and trimmed in, replacing the synthesized placeholder it's
meant to upgrade (each reserved row's `use` column says which key).

## Layout

- `manifest.json` — every sound: key, category, recipe (name into
  `recipes.py`) + args, output path, licence/source. `far: true` entries
  get a `<key>_far` sibling auto-derived by `synth.derive_far` (quieter,
  low-passed, longer tail) — authored once, rendered twice.
- `synth.py` — ffmpeg-only layer primitives (`Layer`, `render_layers`,
  `derive_far`, `apply_radio_filter`, `ebur128_report`).
- `recipes.py` — one function per manifest `recipe` name; this is where
  the actual sound design lives (frequencies, envelopes, layer counts).
- `build.py` — CLI: renders manifest entries, writes `ASSETS.md`'s
  `## Audio` section, optionally writes the loudness report.
- `validate.py` — the gate (see below); `test_manifest.py` wraps it as
  `unittest`.

## Usage

```
python3 tools/audiogen/build.py                    # render everything, write ASSETS.md
python3 tools/audiogen/build.py --only weapon       # one category
python3 tools/audiogen/build.py --assets-only       # just refresh ASSETS.md
python3 tools/audiogen/build.py --loudness-report   # render + docs/reviews/beta/audio-loudness.md
python3 tools/audiogen/build.py --dry-run           # print the plan, write nothing
python3 tools/audiogen/build.py --offline           # skip any non-synthesis (url) entries
python3 tools/audiogen/validate.py                  # the gate
python3 tools/audiogen/test_manifest.py -v          # same checks, unittest-shaped
```

Rendering requires the `audioconverter` binary
(`build/{release,prod,debug}/tools/audioconverter/audioconverter` —
auto-detected, or pass `--audioconverter PATH`) and `ffmpeg` on `PATH`.

## Known gaps for the next lane that touches audio

- **Close/`_far` distance switching is not wired.** Every weapon key has a
  `_far` sibling in `sounds.lua` with `maxdist=900` on the close variant
  per the brief, but nothing currently *picks* `_far` at >900 elmos — that
  dispatch needs the listener/emitter distance, which lives in
  `client/src/core/sound-events.ts` (not owned by this lane). Today the
  close variant just goes silent past 900 elmos instead of handing off to
  the far one; nothing is broken, the upgrade just isn't wired yet.
- **`setReverbPreset` has no caller.** `client/src/core/audio.ts`'s
  `setReverbPreset(preset, contentBaseUrl)` already works and this pass
  supplies the 3 IRs it needs (`sounds/efx/{open,valley,urban}.webm`), but
  `map-data.ts` parses `mapinfo.lua`'s `sound.preset` into
  `ParsedMapData.soundPreset` and nothing ever reads that field — no
  worker→main message carries it, so `setReverbPreset` is never called.
  Wiring that needs a change in `game-processor.ts` (mutex `gp`, not owned
  by this lane) plus a `main.ts` message-handler case.
- **`unit-fx.json` has no death *sound* slot** (only a visual death
  effect name per class). The 6 `death_*` SoundItems in `sounds.lua` exist
  and resolve, but nothing calls them yet.
