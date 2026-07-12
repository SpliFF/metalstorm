"""solve_ground — per-key body-Y ground solve for fable_colossus clips.

For each walk key, runs leg FK (both legs, mirrored phase) over the foot
sole/heel/toe corners and prints the dy that puts the lowest corner at
ground level. Death keys get contact targets too (feet, then knees).
"""
import numpy as np
import colossus_layout as C


def rx(deg):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


FOOT_CORNERS = [   # foot-local probe points (x ignored)
    (0, -1.33, 0.95),    # heel bottom-rear
    (0, -1.33, -1.15),   # ball
    (0, -1.33, -2.05),   # toe
    (0, -1.29, -2.05),
]


def shifted(tbl):
    n = len(tbl)
    half = (n - 1) // 2
    return [tbl[(i + half) % (n - 1)] for i in range(n - 1)] + [tbl[half % (n - 1)]]


def leg_min_y(thigh, shin, foot, hip_y):
    knee = rx(thigh) @ np.array(C.KNEE)
    ankle = knee + rx(thigh + shin) @ np.array(C.ANKLE)
    lows = []
    for c_ in FOOT_CORNERS:
        p = ankle + rx(thigh + shin + foot) @ np.array(c_)
        lows.append(hip_y + p[1])
    return min(lows)


def foot_comp(thigh, shin, add):
    f = -(thigh + shin) * C.WALK_FOOT_COMP
    f = max(-C.WALK_FOOT_CLAMP, min(C.WALK_FOOT_CLAMP, f))
    return max(-32.0, min(32.0, f + add))


thigh_r = shifted(C.WALK_THIGH)
shin_r = shifted(C.WALK_SHIN)
add_r = shifted(C.WALK_FOOT_ADD)

print('key | dy needed (lowest corner at 0)')
dys = []
for i in range(len(C.WALK_THIGH)):
    fl = foot_comp(C.WALK_THIGH[i], C.WALK_SHIN[i], C.WALK_FOOT_ADD[i])
    fr = foot_comp(thigh_r[i], shin_r[i], add_r[i])
    low_l = leg_min_y(C.WALK_THIGH[i], C.WALK_SHIN[i], fl, C.HIP_Y)
    low_r = leg_min_y(thigh_r[i], shin_r[i], fr, C.HIP_Y)
    dy = -min(low_l, low_r)
    dys.append(dy)
    print(f'{i}  | {dy:+.3f}   (L {low_l:+.3f}  R {low_r:+.3f})')
print('WALK_BODY_Y =', [round(d, 3) for d in dys])
