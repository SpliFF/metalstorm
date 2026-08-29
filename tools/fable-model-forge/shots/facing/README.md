# facing/ — squad member facing, before and after

Evidence for the "tanks drive backwards" fix (USER-REPORTED 2026-08-29,
`crossing_standoff`). See the commit that adds `steering.js`'s
`headingFromVelocity`.

## How to read the pair

`before_side.png` and `after_side.png` are the SAME shot: one `ms_tanks_s2`
squad on Scorched Crossing, driving due **+Z**, framed with

```js
await test.sun({ azimuthDeg: 200, elevationDeg: 50 });
await test.orbit(<unitId>, { yawDeg: 0, pitchDeg: 16, distance: 70, follow: true });
```

`orbit`'s `yawDeg: 0` puts the camera due **+X** of the unit looking along
−X — confirmed both times from `test.cameraPose()` (camera and look-at share
a Z, camera X is larger). In that view the world axes land on screen as:

| world | screen |
| ----- | ------ |
| `+Z`  | LEFT   |
| `−Z`  | RIGHT  |

So a tank driving `+Z` is travelling **toward the left of frame**, and the
end of the hull that points left is the end that leads.

- **`before_side.png`** — barrels point RIGHT. The hulls are being dragged
  rear-first. Engine at that instant: `v = (0.420, 2.464)`,
  `frontdir = (0.168, 0.986)`, `v · frontdir = +1.0000` — the sim had it
  right; only the drawing was reversed.
- **`after_side.png`** — barrels point LEFT, along the travel direction.
  Engine `v = (0.249, 2.488)`, and all four members now report
  `renderedForward == v̂` to three decimals.

`before_3quarter.png` is the same defect from `yawDeg: 60`, kept because the
reversed glacis and engine deck read more clearly at 3/4 than side-on.

## Reproducing

The measurement that separates "model is wrong" from "renderer is wrong" is
`Spring.GetUnitVelocity` · `Spring.GetUnitDirection` on a driving unit. A dot
near **+1** means the engine drives the unit forward and any reversal you can
see is purely visual — do not touch the models. It was +0.9995 here.
