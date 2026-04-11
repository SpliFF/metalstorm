# gameconverter

Standalone CLI that prepares a legacy Spring-archive game for use with
spring-web's lobby + sim. Mirrors `modelimporter` in spirit — a content
preprocessor you run once per game archive (or automatically at lobby
startup) to get the files into the shapes the engine expects.

## What it does

Four idempotent steps:

1. **`game.config.lua`** — writes a thin wrapper around the legacy
   `modinfo.lua`:

   ```lua
   local config = VFS.Include('modinfo.lua') or {}
   config.configVersion = "1"
   return config
   ```

   This file describes the *game itself* (name, version, description,
   dependencies). It runs in the lobby's config environment at
   discovery time and will eventually also run in the sim's config
   environment at game-boot time — so it must stay free of any
   lobby-only globals.

2. **`lobby.config.lua`** — a parallel wrapper around `modoptions.lua`:

   ```lua
   return {
       configVersion = "1",
       options = VFS.Include('modoptions.lua') or {},
   }
   ```

   This file describes the *per-game setup options* (the checkboxes,
   sliders, dropdowns a lobby shows when creating a room). It runs
   **only** in the lobby environment; the sim never touches it. Keeping
   it separate from `game.config.lua` preserves Spring's historical
   boundary between "game rules the engine cares about" and "knobs
   the lobby offers the host at room creation".

   Games with no `modoptions.lua` still get a `lobby.config.lua` with
   an empty `options` list, so the lobby has a single code path for
   reading per-game options.

3. **Model conversion** — every model file under `<game>/objects3d/`
   (case-insensitive) is handed to `modelimporter`, which writes
   glTF output to `data/games/<game-id>/models/<stem>.glb` plus a
   sibling `<stem>.config.json`. Files whose cached output is newer
   than the source are skipped, matching the same idempotency rule
   `GameProcessor` uses inside the lobby.

4. **AI migration** — walks `<game>/ai/` and normalises its shape:

   - `ai/<name>.lua` → moves to `ai/<name>/main.lua` and writes a
     fresh `ai.config.lua` with `name = "<name>"` and
     `entry = "main.lua"`.
   - `ai/<name>/` (existing folder, no `ai.config.lua`) → writes a
     stub `ai.config.lua` inferring `entry` from whichever `.lua`
     file looks like the main entry (prefers `main.lua`).

   Legacy shapes outside these two cases (game-root `LuaAI.lua`,
   Spring `SkirmishAI` folders with native plugins, etc.) are left
   alone — they need manual attention and the converter shouldn't
   pretend otherwise.

## Usage

```
gameconverter [options] <game-dir>

options:
  --force              Overwrite existing game.config.lua /
                       lobby.config.lua / model outputs even if they
                       look up to date.
  --modelimporter P    Path to the modelimporter binary. Defaults to
                       ./build/debug/tools/modelimporter/modelimporter,
                       falling back to ./build/release/... if present.
  --skip-models        Do not run modelimporter. Useful when the lobby
                       has already cached the glb outputs or you just
                       want to refresh the config wrappers / AI layout.
  --skip-ai            Do not touch ai/ — leave the legacy layout alone.
```

Typical usage from the repo root:

```sh
# Full convert of a single game
./build/debug/tools/gameconverter/gameconverter content/games/papertanks

# Convert every game in content/games/
for g in content/games/*/; do
    ./build/debug/tools/gameconverter/gameconverter --force "$g"
done

# Just refresh the config wrappers after a template change
./build/debug/tools/gameconverter/gameconverter --force --skip-models content/games/zk
```

Each step is safe to re-run. The converter is designed to be cheap
enough to invoke from CI or from a pre-flight hook on every lobby
startup, and it never destroys hand-authored metadata unless
`--force` is passed.

## Why Lua wrappers instead of rewriting the legacy files?

We deliberately don't parse or re-serialise `modinfo.lua` /
`modoptions.lua`. Those files are hand-written Lua scripts that can
use conditionals, math, or `VFS.Include` chains of their own; a
regex-based or one-shot Lua-to-Lua rewriter would break in corner
cases and silently produce incorrect output.

Instead, the lobby's
[`ConfigReader`](../../rts/Server/ConfigReader.cpp) ships a minimal
`VFS.Include(path)` shim that resolves paths relative to the archive
root and loads/evaluates the referenced file at runtime. That means
the one-time cost of "convert" is just writing these two short
wrapper scripts, and any author edits to `modinfo.lua` or
`modoptions.lua` take effect on the next lobby start without
re-running the converter.

## Relationship to `modelimporter`

`gameconverter` shells out to `modelimporter` via `popen` for each
model file. Nothing is linked — if you want to run the tool against
a different modelimporter build, pass `--modelimporter <path>`.
