# turn-arc — unit-motion M1 evidence (2026-08-29)

`ms_tanks_s2`, four squads in column, flat map (`green_flat_x34_v3`), settled on
a straight +Z leg, then ordered a hard 180 back down their own track. Fixed
camera; the three frames are the same camera pose at three moments.

| frame | what it shows |
|---|---|
| `01-column-straight.jpg` | Cruising. Every hull on the same heading, barrels aligned. |
| `02-column-mid-180.jpg`  | Mid-reversal. Hulls fanned across a range of headings, the column tracing a curve rather than rotating on the spot. |
| `03-column-after-180.jpg`| Steadied on the reciprocal course. |

Measured on the same run (sim centroid + drawn member sampled at 16 ms from the
render worker, circle-fit over the turn window):

```
90 deg course change   1.44 s   1.08 rad/s   60.7 e/s through the turn
                       R = 54.8 elmos = 6.9 m   circle-fit residual 0.0
                       drawn member R = 47.1 elmos = 5.9 m
                       0.77 hull lengths (hull 72.16 elmos = 9.0 m)

180 deg reversal       2.86 s   1.076 rad/s   60.0 e/s
                       R = 54.6 elmos = 6.8 m   0.76 hull lengths
                       lateral sweep 110 elmos = 13.7 m  (ideal 2R = 13.6 m)
                       worst single-frame drawn heading step: 1.44 deg

BEFORE the tanks.lua fix, same protocol:
                       R = 20.3 elmos = 2.5 m   32.1 e/s through the turn
                       0.28 hull lengths — a pivot, not an arc
```

The overlap visible in `02` is M2's defect, not M1's.
