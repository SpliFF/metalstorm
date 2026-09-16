# game-browser-test reference — measurement traps for perf work in the browser

Split out of [SKILL.md](SKILL.md) (2026-09-10). Each trap below was paid for.
Full methodology: [docs/debugging-performance.md](../../../docs/debugging-performance.md).

## Measurement traps (perf work in the browser)

Full methodology: [docs/debugging-performance.md](../../../docs/debugging-performance.md). The traps below were each paid for:

**⚠️ Changing the render resolution is one-way — read the buffer back.**
`setHardwareScalingLevel` scales the *current* backing store rather than
re-deriving it from a CSS size (the renderer runs on an OffscreenCanvas in the
worker, which has no CSS size), so it does not round-trip **and it compounds**:
960×600 → `(1.333)` → 720×450 → `(1)` → 720×450 → `(1.333)` → 540×337 (PLAN-perf
M3/M4). To restore, set the level back to **1** *and* trigger a **real** page
resize — a genuinely different size, then the one you want (the 1280→1281→1280
nudge does not work). After ANY resolution change, confirm what you are
actually measuring — only believe `getRenderWidth()`, never the level:

```js
await window.__gp(`(()=>{const e=__entityRenderer.scene.getEngine();
  return [e.getRenderWidth(), e.getRenderHeight()];})()`);
```

Note `setHardwareScalingLevel` also **does not take effect within the same
call** — re-read after a frame (~1.5 s) and loop until it matches the target.

**⚠️ A toggle that recompiles a shader makes the frame look fast — it isn't.**
Babylon skips drawing any mesh whose effect is not ready, so for several seconds
after you flip a material plugin, re-enable a mesh, or detach a post pipeline,
the frame is cheap *because half the scene is missing*. M4 hit this three times;
the worst case reported a −11.7 ms "win" that a settled window showed to be
**0.0 ms**. Two tells, both cheap: the distribution goes **bimodal** (`p50` far
below `p95` where a settled window has p95 ≈ p50 + 2 ms), and **draw calls per
frame** drop below what the scene should be issuing. After any such toggle,
settle **12–20 s**, and gate the window on a draw-call count in the expected
range. Draw calls are not per-frame anywhere obvious — `engine._drawCalls.current`
is cumulative, so sample it twice against `engine.frameId` and divide.

**⚠️ `mesh.isVisible = false` does not stick if something re-asserts it — use
`setEnabled(false)`.** Per-frame flush code commonly re-derives visibility
(`SquadRenderBackend.flushPool` does exactly this —
`pool.mesh.isVisible = pool.highWater > 0` in
`client/src/core/squad-render-backend.ts`), so an A/B that hides meshes that
way measures **nothing while looking like it worked** (PLAN-perf M11). The tell
was **draws/frame going UP** in the window that was supposed to remove geometry —
carry draws/frame as the gate on any "I removed geometry" arm, and treat a draw
count that moves the wrong way as proof the lever never engaged, not noise.

**⚠️ A CDP async measurement job only advances while an `evaluate_script` is
actively awaiting.** Kick a timing window off as a floating promise, then poll it
by reading a result global, and it reports `state: 'running'` for **minutes**
after it has actually finished. Poll with an awaited call — e.g.
`async () => { await window.test.perfDump(500); return window.__winResult; }` —
or the window looks hung.

**⚠️ No CPU phase timer sees GPU fragment cost — on a fillrate A/B, quote frame
time, not the `render` phase.** M8 removed the CSM depth-bounds readback (a GPU
sync point), and with it the lane's only accidental view of GPU cost. When a
lever moves several unrelated CPU phases by a little, you are reading
**backpressure**, and the true cost is in frame time. A pre-M8 `render`-phase
number for anything fillrate-bound is not comparable to a post-M8 one — the
instrument changed, not the cost.

**⚠️ A GPU cost measured on an idle scene is not that cost under load.** Load
moves the bottleneck: PLAN-maps **M7c** took a terrain-splat toggle worth
**≈1.8 ms idle** and measured **0.484 ms** under a real battle at the strategic
pose (73 % absorbed) and **nothing** at the gameplay pose. Absorption falls as
the buffer grows, so quote *both* the load and the buffer with any fillrate
number.

**⚠️ `window.test.perfDump(ms)` reads the ring buffer and returns immediately —
it does not wait `ms`.** `perfReset()` followed straight by `await perfDump(20000)`
returns a fully-populated table of **zeros**, which reads like a broken profiler
rather than a missing sleep. **`test.perfCapture(windowMs)` exists precisely to
close this trap** — it resets, waits a REAL window, then dumps. Use it.

**⚠️ A vsync cap silently truncates the cheap arm, turning a delta into a lower
bound.** On a 120 Hz display the cheap arm returned **exactly 2400 frames per
20 s window (120.0 fps) every time** — a clamp, not a measurement. Exact-integer
frame counts and an fps pinned to the refresh rate are the tells. Escape it by
scaling the render buffer in the worker until **both** arms sit below the cap —
subject to the one-way/compounding trap above (compute
`level = currentWidth / targetWidth` and read `getRenderWidth()` back). And Δ is
**not** linear in megapixels over a wide range, so normalise back to the
reference buffer only from the nearest uncapped rung, never the biggest one.

**⚠️ `EXT_disjoint_timer_query_webgl2` is available here and is not trustworthy
as an absolute.** It charged **13.3 ms of "GPU time" inside a 9.29 ms wall-clock
frame** on a saturated arm — it counts pipeline wait, not busy time, so the
ratio between arms is inflated beyond use. Query overhead itself is negligible,
so it is safe to leave installed; just don't quote it.
