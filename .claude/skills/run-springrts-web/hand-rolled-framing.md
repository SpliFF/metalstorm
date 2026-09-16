# run-springrts-web reference — hand-rolled screenshot framing

Split out of [SKILL.md](SKILL.md) (2026-09-10). Reach for this only when
`capture_subject`'s presets do not reach the camera pose you need. The full
camera contract is in
[../spring-debug/capture-and-camera.md](../spring-debug/capture-and-camera.md).

Everything below is the hand-rolled path, for when you need the camera somewhere
`capture_subject`'s presets do not reach.

Camera is client-side; no admin needed. Via the relay (`client_eval
{target:'test'}`) or chrome-devtools `evaluate_script`:

```js
// angled, HUD-clear 3/4 view — aim a ground point offset from the unit
await test.cameraSnapToGround(829, 1298, {height:150, pitchDeg:28, durationMs:0});
```

Then `client_screenshot {maxDim: 1280}` for a viewable image, or
`await test.captureFrame({stats:true})` for the raw
`{dataUrl, width, height, frameId, gameFrame, stats}` — deterministic, never a
between-frames black. Use CDP `take_screenshot` only for DOM/HUD overlays (the
canvas captures black under CDP — see game-browser-test). Inspect the render
worker with:

```js
await window.__gp(`(()=>{const er=self.__entityRenderer; return er.scene.meshes.length;})()`);
```

`window.__gp(expr)` evaluates JS **inside the render worker** (where the Babylon
scene / `__entityRenderer` / materials live) — the main introspection handle.
Other worker hooks: `__frameProfiler.dump()`, `__uiTextures.dump()` (the LuaUI
HUD texture cache — resolvedUrl/loadedUrl/loaded/lastError per entry).
Example screenshot of a working drive: `.claude/skills/run-springrts-web/example-cuspbr-corcom.jpg`.
