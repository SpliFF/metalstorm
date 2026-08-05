"""gen_ms_anc_reactor — assemble ms_anc_reactor and export .gltf/.bin.

ANCIENT REGISTER, ACTIVE. 25 m geothermal core tap:
  body  — crater apron (buried skirt, shelf, recessed step), hemispherical
          containment dome with 8 proud meridian ribs, oculus collar,
          exposed cyan core column with three containment collars, four
          cantilevered buttress pylons, flared crown, floating capstone
          emitter, 12 radiator fins, 3 conduit runs to grid stubs.
  ring  — large floating gyroscopic ring (tilt baked in), +2 rev / 180 s.
  ring2 — smaller counter-rotating gyroscopic ring, -4 rev / 180 s.
Seamless loop; no team colour.
Run: python3 gen_ms_anc_reactor.py -> out/ms_anc_reactor{,_png}.gltf
"""
import numpy as np

import ms_anc_reactor_layout as F   # sets meshlib.ATLAS = 2048
import meshlib as M
from meshlib import Part, Zone, limb, ngon_ring
from gltf_export import export
import parts as P

STEM = 'ms_anc_reactor'
OUT = 'out'
RNG = np.random.default_rng(90210)


# ── helpers ──────────────────────────────────────────────────────────────

def yring(r, y, n):
    """Horizontal n-gon vertex ring centred on the Y axis."""
    return ngon_ring((0.0, y, 0.0), r, n=n, axis='y')


def skin(p, stations, n, zone):
    """Skin a list of (y, radius) stations into a solid of revolution."""
    rings = [yring(r, y, n) for (y, r) in stations]
    P._ring_solid(p, rings, zone, axis='y')
    return rings


def disc(p, ring, zone, up=True):
    """Flat cap from a horizontal ring. ngon_ring(axis='y') winds so that the
    raw Newell normal is -Y, hence flip for an up-facing cap."""
    p.add_face(list(ring), zone=zone, flip=bool(up))


def annulus(p, r_in, r_out, y, n, zone, up=True):
    a = yring(r_in, y, n)
    b = yring(r_out, y, n)
    out = (0.0, 1.0 if up else -1.0, 0.0)
    for j in range(n):
        k = (j + 1) % n
        P.quad_out(p, [a[j], a[k], b[k], b[j]], out, zone)


def face_out(p, verts, uvs, outward):
    """Explicit-UV polygon wound toward `outward`."""
    a, b, c = (np.asarray(verts[i], dtype=float) for i in range(3))
    nn = np.cross(b - a, c - a)
    if np.dot(nn, np.asarray(outward, dtype=float)) > 0:
        p.add_face(verts, uvs=uvs)
    else:
        p.add_face(verts[::-1], uvs=uvs[::-1])


def rect_uv(rect, fu, fv):
    x0, y0, x1, y1 = rect
    return ((x0 + (x1 - x0) * fu) / M.ATLAS, (y0 + (y1 - y0) * fv) / M.ATLAS)


def polar(az_deg, r, y):
    a = np.radians(az_deg)
    return (r * np.cos(a), y, r * np.sin(a))


# ── body ─────────────────────────────────────────────────────────────────

def build_apron(p):
    """Crater apron: buried skirt, chamfered shelf, recessed step, floor."""
    n = F.N_APRON
    # outer skirt (bottom buried in soil) + top chamfer
    skin(p, [(F.APRON_Y_BOT, F.APRON_R_OUT),
             (F.APRON_Y_CH,  F.APRON_R_OUT),
             (F.APRON_Y_TOP, F.APRON_R_LIP)], n, F.R_SKIRT)
    # shelf annulus
    annulus(p, F.APRON_R_IN, F.APRON_R_LIP, F.APRON_Y_TOP, n, F.R_DISC)
    # inner chamfer down to the crater step + step wall
    skin(p, [(F.APRON_Y_TOP, F.APRON_R_IN),
             (F.APRON_Y_CH,  F.APRON_R_STEP),
             (F.CRATER_Y,    F.APRON_R_STEP)], n, F.R_SKIRT)
    # crater floor
    annulus(p, F.CRATER_R, F.APRON_R_STEP, F.CRATER_Y, n, F.R_DISC)


def dome_station(th):
    return (F.DOME_CY + F.DOME_R * np.sin(th), F.DOME_R * np.cos(th))


def build_dome(p):
    n = F.N_DOME
    st = [dome_station(F.DOME_TH_MAX * k / F.DOME_BANDS)
          for k in range(F.DOME_BANDS + 1)]
    skin(p, st, n, F.R_DOME)
    # proud meridian ribs, riding just outside the sphere, between pylons
    ths = [t if t is not None else F.DOME_TH_MAX for t in F.RIB_TH]
    for i in range(F.RIB_N):
        az = F.RIB_AZ0 + 360.0 * i / F.RIB_N
        pts = []
        for th in ths:
            y, r = dome_station(th)
            rr = r + F.RIB_PROUD * np.cos(th)
            yy = y + F.RIB_PROUD * np.sin(th)
            pts.append(polar(az, rr, yy))
        for k in range(len(pts) - 1):
            limb(p, pts[k], pts[k + 1], F.RIB_R[k], F.RIB_R[k + 1],
                 F.R_RIB, n=6)


def build_collar(p):
    n = F.N_DOME
    skin(p, [(F.COLLAR_Y0, F.COLLAR_R0),
             (F.COLLAR_Y1, F.COLLAR_R0),
             (F.COLLAR_Y2, F.COLLAR_R1)], n, F.R_COLLAR)
    # close the collar top (the core column rises through it)
    disc(p, yring(F.COLLAR_R1, F.COLLAR_Y2, n), F.R_DISC, up=True)


def core_r(y):
    t = (y - F.CORE_Y0) / (F.CORE_Y1 - F.CORE_Y0)
    return F.CORE_R0 + (F.CORE_R1 - F.CORE_R0) * t


def build_core(p):
    st = [(F.CORE_Y0, core_r(F.CORE_Y0))]
    for h in F.CORE_RIBS:
        rb = core_r(h)
        st += [(h - 0.20, rb), (h - 0.10, rb + F.CORE_RIB_D),
               (h + 0.10, rb + F.CORE_RIB_D), (h + 0.20, rb)]
    st.append((F.CORE_Y1, core_r(F.CORE_Y1)))
    skin(p, st, F.N_CORE, F.R_CORE)


def build_crown(p):
    n = F.N_CROWN
    skin(p, list(F.CROWN), n, F.R_CROWN)
    disc(p, yring(F.CROWN[-1][1], F.CROWN[-1][0], n), F.R_CROWNTOP, up=True)
    # thin cyan rod bridging the gap to the floating capstone
    limb(p, (0.0, F.BEAM_Y0, 0.0), (0.0, F.BEAM_Y1, 0.0),
         F.BEAM_R, F.BEAM_R, F.R_BEAM, n=6)
    # floating capstone emitter: an 8-gon lens (bipyramid)
    mid = yring(F.CAP_R, F.CAP_MID_Y, F.CAP_N)
    top = (0.0, F.CAP_TOP_Y, 0.0)
    bot = (0.0, F.CAP_Y0, 0.0)
    for j in range(F.CAP_N):
        k = (j + 1) % F.CAP_N
        c = (np.asarray(mid[j]) + np.asarray(mid[k])) / 2
        rad = np.array([c[0], 0.0, c[2]])
        P.quad_out(p, [mid[j], mid[k], top], rad + np.array([0, 1.2, 0]), F.R_CAP)
        P.quad_out(p, [mid[j], mid[k], bot], rad + np.array([0, -1.2, 0]), F.R_CAP)


def build_pylons(p):
    br, by = F.PYLON_BASE
    kr, ky = F.PYLON_KNEE
    tr, ty = F.PYLON_TOP
    r0, r1, r2 = F.PYLON_R
    for az in F.PYLON_AZ:
        a = polar(az, br, by)
        b = polar(az, kr, ky)
        c = polar(az, tr, ty)
        limb(p, a, b, r0, r1, F.R_PYLON, n=6)
        limb(p, b, c, r1, r2, F.R_PYLON, n=6)
        # knee collar hides the frame discontinuity between the two limbs
        da = (np.asarray(b) - np.asarray(a))
        da /= np.linalg.norm(da)
        db = (np.asarray(c) - np.asarray(b))
        db /= np.linalg.norm(db)
        limb(p, tuple(np.asarray(b) - da * 0.62), tuple(np.asarray(b) + db * 0.62),
             F.PYLON_COLLAR_R, F.PYLON_COLLAR_R, F.R_PYLON, n=6)


def build_fins(p):
    """12 radial swept radiator blades on the apron shelf."""
    hspan = F.FIN_Y1_IN - F.FIN_Y0
    prof = F.FIN_PROFILE

    def params(pt):
        r, y = pt
        return ((r - F.FIN_R0) / (F.FIN_R1 - F.FIN_R0),
                (F.FIN_Y1_IN - y) / hspan)

    for i in range(F.FIN_N):
        az = np.radians(F.FIN_AZ0 + 360.0 * i / F.FIN_N)
        d = np.array([np.cos(az), 0.0, np.sin(az)])
        t = np.array([-np.sin(az), 0.0, np.cos(az)])
        up = np.array([0.0, 1.0, 0.0])
        half = t * (F.FIN_T / 2)
        pts3 = [d * r + up * y for (r, y) in prof]
        A = [tuple(q + half) for q in pts3]
        B = [tuple(q - half) for q in pts3]
        uvA = [rect_uv(F.R_FIN_FACE, *params(q)) for q in prof]
        face_out(p, A, uvA, t)
        face_out(p, B, uvA, -t)
        # rim faces: inner, swept top, outer (bottom sits on the shelf).
        # u runs along the profile PERIMETER — a radial param would collapse
        # the two vertical rims to zero UV width.
        outs = [-d, d * 1.55 + up * 1.43, d]
        for e, (j, k) in enumerate(((0, 1), (1, 2), (2, 3))):
            s0, s1 = F.FIN_PERIM[j], F.FIN_PERIM[k]
            uvs = [rect_uv(F.R_FIN_EDGE, s0, 0.0),
                   rect_uv(F.R_FIN_EDGE, s1, 0.0),
                   rect_uv(F.R_FIN_EDGE, s1, 1.0),
                   rect_uv(F.R_FIN_EDGE, s0, 1.0)]
            face_out(p, [A[j], A[k], B[k], B[j]], uvs, outs[e])


def build_grid(p):
    """Conduit runs out to three monolithic grid stubs."""
    for az in F.STUB_AZ:
        limb(p, polar(az, F.CONDUIT_R0, F.CONDUIT_Y0),
             polar(az, F.CONDUIT_R1, F.CONDUIT_Y1),
             F.CONDUIT_RAD, F.CONDUIT_RAD, F.R_CONDUIT, n=6)
        limb(p, polar(az, F.STUB_R, 0.0), polar(az, F.STUB_R, F.STUB_Y),
             F.STUB_R0, F.STUB_R1, F.R_STUB, n=4, cap_end=F.R_DISC)


def build_body():
    p = Part('body')
    build_apron(p)
    build_dome(p)
    build_collar(p)
    build_core(p)
    build_crown(p)
    build_pylons(p)
    build_fins(p)
    build_grid(p)
    return p


# ── gyroscopic rings ─────────────────────────────────────────────────────

def tilt_x(v, deg):
    t = np.radians(deg)
    x, y, z = v
    return (x, y * np.cos(t) - z * np.sin(t), y * np.sin(t) + z * np.cos(t))


def build_ring(name, radius, bar, tilt):
    """Ring built about the piece origin, tilt baked into the geometry so a
    plain Y-spin reads as gyroscopic precession."""
    p = Part(name)
    n = F.RING_N
    verts = [tilt_x(v, tilt) for v in ngon_ring((0.0, 0.0, 0.0), radius,
                                                n=n, axis='y')]
    for i in range(n):
        a, b = verts[i], verts[(i + 1) % n]
        limb(p, a, b, bar, bar, F.R_RING, n=6)
    # emitter node spikes on every Nth vertex, pointing out along the ring plane
    for i in range(0, n, F.NODE_EVERY):
        v = np.asarray(verts[i], dtype=float)
        outw = v / np.linalg.norm(v)
        limb(p, tuple(v - outw * 0.10), tuple(v + outw * F.NODE_LEN),
             F.NODE_R0, F.NODE_R1, F.R_NODE, n=6)
    return p


def qy(deg):
    r = np.radians(deg) / 2.0
    return (0.0, float(np.sin(r)), 0.0, float(np.cos(r)))


def spin_keys(revs, total):
    """90-degree quaternion steps over `total` seconds; even revs land the
    track back on the exact identity key, so the loop is seamless."""
    steps = int(round(abs(revs) * 4))
    sgn = 1.0 if revs >= 0 else -1.0
    return [(total * k / steps, qy(sgn * 90.0 * k)) for k in range(steps + 1)]


def build_clips():
    return [{'name': 'idle', 'channels': [
        ('ring',  'rotation', spin_keys(F.RING1_REV, F.IDLE_T)),
        ('ring2', 'rotation', spin_keys(F.RING2_REV, F.IDLE_T)),
    ]}]


def build_all():
    return [
        dict(name='body',  parent=-1, offset=(0, 0, 0), part=build_body()),
        dict(name='ring',  parent=0,  offset=F.RING1_PIVOT,
             part=build_ring('ring',  F.RING1_R, F.RING1_BAR, F.RING1_TILT)),
        dict(name='ring2', parent=0,  offset=F.RING2_PIVOT,
             part=build_ring('ring2', F.RING2_R, F.RING2_BAR, F.RING2_TILT)),
    ]


if __name__ == '__main__':
    pieces = build_all()
    clips = build_clips()
    export(pieces, STEM, texmode='ktx2', outdir=OUT, clips=clips, normal_map=True)
    export(pieces, STEM, texmode='png', outdir=OUT, clips=clips, normal_map=True)
    total = sum(pc['part'].tri_count() for pc in pieces if pc['part'])
    for pc in pieces:
        print(f"  {pc['name']}: {pc['part'].tri_count()} tris")
    print(f'{STEM}: {total} tris')
