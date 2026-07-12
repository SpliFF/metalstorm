"""solve_death — ground-contact solve for the fable_colossus death clip.

Runs whole-body FK (body pitch + leg chains + torso/arm chains) at every
death key over the contact-candidate points (foot corners, toe tips,
knee bearing bottoms, pelvis bottom, chest plate front, jaw, knuckle
guards) and prints the body-Y that puts the lowest point exactly at
ground. Yaw is ignored — rotation about +Y never changes heights.
"""
import numpy as np
import colossus_layout as C


def rx(deg):
    t = np.radians(deg)
    c, s = np.cos(t), np.sin(t)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


FOOT_PTS = [(0, -1.33, 0.95), (0, -1.33, -1.05), (0, -0.62, -1.10)]
TOE_PTS = [(0, -0.38, -0.95), (0, -0.16, -0.98), (0, -0.38, 0.05)]
KNEE_R = 0.60          # knee bearing radius (contact when kneeling)
PELVIS_PTS = [(0, 6.90, 1.30), (0, 6.90, -1.30)]
# turret-local chest / collar / cowl front lower corners
TORSO_PTS = [(0, 1.00, -2.85), (0, 2.70, -2.95), (0, -0.10, 1.10),
             (0, 3.90, -2.30)]
HEAD_PTS = [(0, -0.92, -0.85), (0, -0.62, -1.80)]      # jaw, snout tip
GUN_PTS = [(0, -1.13, -1.65), (0, -0.18, -3.85)]       # knuckle, muzzle
ARM_PTS = [(0, -2.70, -0.60)]                          # elbow


def solve():
    n = len(C.DEATH_KEYS)
    out = []
    for i in range(n):
        bp = C.DEATH_BODY_PITCH[i]
        Rb = rx(bp)
        bx, by, bz = C.DEATH_BODY[i]
        lows = []

        # legs (both share tables up to small factors)
        for (tf, sf, ff, of) in ((1.0, 1.0, 1.0, 1.0), (0.94, 1.05, 0.9, 0.92)):
            th = C.DEATH_THIGH[i] * tf
            sh = C.DEATH_SHIN[i] * sf
            ft = C.DEATH_FOOT[i] * ff
            te = C.DEATH_TOE[i] * of
            hip = np.array([C.HIP_X, C.HIP_Y, 0.0])
            knee = hip + rx(th) @ np.array(C.KNEE)
            ankle = knee + rx(th + sh) @ np.array(C.ANKLE)
            lows.append((Rb @ knee)[1] + by - KNEE_R)
            for p_ in FOOT_PTS:
                p = ankle + rx(th + sh + ft) @ np.array(p_)
                lows.append((Rb @ p)[1] + by)
            toe_base = ankle + rx(th + sh + ft) @ np.array(C.TOE_OFF)
            for p_ in TOE_PTS:
                p = toe_base + rx(th + sh + ft + te) @ np.array(p_)
                lows.append((Rb @ p)[1] + by)

        for p_ in PELVIS_PTS:
            lows.append((Rb @ np.array(p_))[1] + by)

        # torso chain
        tp = C.DEATH_TORSO_PITCH[i]
        t_off = np.array(C.TURRET_OFF)
        Rt = rx(tp)
        for p_ in TORSO_PTS:
            p = t_off + Rt @ np.array(p_)
            lows.append((Rb @ p)[1] + by)
        hp = C.DEATH_HEAD_PITCH[i]
        for p_ in HEAD_PTS:
            p = t_off + Rt @ (np.array(C.HEAD_OFF) + rx(hp) @ np.array(p_))
            lows.append((Rb @ p)[1] + by)
        # right weapon arm chain (arms thrown forward in the fall)
        ap = C.DEATH_ARM[i]
        fp = C.DEATH_FOREARM[i]
        for p_ in GUN_PTS:
            p = t_off + Rt @ (np.array(C.ARM_R_OFF) + rx(ap) @ (
                np.array(C.ELBOW) + rx(fp) @ np.array(p_)))
            lows.append((Rb @ p)[1] + by)
        for p_ in ARM_PTS:
            p = t_off + Rt @ (np.array(C.ARM_R_OFF) + rx(ap) @ np.array(p_))
            lows.append((Rb @ p)[1] + by)

        low = min(lows)
        out.append(round(by - low, 3))
        print(f'k{i:>2} t={C.DEATH_KEYS[i]:.2f}  low={low:+.3f}  '
              f'y {by:+.2f} -> {by - low:+.3f}')
    print('DEATH_BODY_Y =', out)


if __name__ == '__main__':
    solve()
