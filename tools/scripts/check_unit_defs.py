#!/usr/bin/env python3
"""check_unit_defs.py — Metalstorm def ⇄ asset reconciliation census.

One command, no make, no engine, no browser:

    python3 tools/scripts/check_unit_defs.py            # census; exit 1 on FAIL
    python3 tools/scripts/check_unit_defs.py --tables   # + balance/DPS markdown tables
    python3 tools/scripts/check_unit_defs.py --quiet    # only FAIL/WARN lines + summary

Evaluates every `units/*.lua`, `weapons/*.lua`, `features/*.lua` and
`gamedata/sounds.lua` through `dump_defs.lua` (a VFS shim — the same Lua the
engine runs, minus the engine) and asserts, for the whole corpus:

  MODELS    every def's `objectname` resolves to models/<stem>.gltf (unless
            `impostor_only`), the gltf's .bin and every image it references
            exist, and impostor sheets declared by customparams exist.
  WEAPONS   every unit weapon slot names a weapondef; every weapondef's
            `soundstart` is a SoundItem whose file exists; a ballistic Cannon
            can physically reach its declared range (v²/g, g = 130);
            `onlytargetcategory` tokens are categories some def carries.
  FX        effects/weapon-fx.json and effects/unit-fx.json name only real
            weapons, real library.json effects and real SoundItems; every
            builder class has a unit-fx byClass row; every weapon resolves to
            an fx entry (explicit or per-weapontype default).
  BUILDER   ms_class / ms_scale match the file and scale, squad_size is '1'
            at s4, formation_type is a template the client ships, buildoptions
            name shipped defs, movementclass names a moveinfo.tdf class.
  STATS     mobile ⇒ maxvelocity > 0; immobile ⇒ maxvelocity == 0 (the
            MoveTypeFactory SIGSEGV); weapons ⇔ canattack; maxdamage/mass > 0;
            canfly ⇒ cruisealtitude; duplicate def names across files;
            duplicate display names.
  SCALE     the shipped model's dominant dimension vs the DESIGN-GUIDE scale
            table (±25 % WARN) and vs the class's `sizes` clearance row; the
            per-def footprint vs the model's ground extent (single hulls).
  ASSETS    ASSETS.md, with its brace-expansion / "(+.bin, 5 .ktx2)" row
            conventions expanded, covers every file in models/ and names no
            file that is not on disk; no file is covered twice.
  GATE      tools/scripts/check_model_scale.py passes (world scale ×8).

Severity: FAIL = a dead reference or a contract violation the engine or client
will act on; WARN = a review flag (scale drift, a default fallback in use).
Exit 0 iff no FAIL. Written for the 2026-09-10 units-assets review lane; the
review report explains each rule's provenance.
"""
from __future__ import annotations

import argparse
import glob
import itertools
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
GAME = os.path.join(REPO, 'data', 'games', 'metalstorm')
ELMOS_PER_METRE = 8.0
GRAVITY = 130.0            # engine default, elmos/s²; the maps ship no override

# DESIGN-GUIDE.md scale table: class -> (axis of the dominant dimension, m per scale).
# 'y' = height, 'z' = length, 'x' = span, 'ground' = max(x, z).
SCALE_TABLE = {
    'soldiers':      ('y', [1.8, 1.85, 1.9, 2.1]),
    'engineers':     ('y', [1.8, 1.85, 1.9, None]),   # s4 is a 20 m crawler by ruling
    'tanks':         ('z', [4.5, 8.5, 12, 26]),
    'artillery':     ('z', [4.5, 7.5, 10.5, 15]),
    'mechs':         ('y', [3, 5, 7.5, 11]),
    'fighters':      ('x', [6, 9, 12, 16]),
    'bombers':       ('x', [8, 12, 16, 22]),
    'ships':         ('z', [20, 35, 55, 80]),
    'subs':          ('z', [18, 30, 45, 65]),
    'staticdefense': ('y', [3, 4.5, 6, 8]),
    'radar':         ('y', [4, 6, 8, 11]),
}
SCALE_TOL = 0.25
# Showcase hulls wired into a roster slot by user ruling; their size is the
# hull's, not the table's, and is accepted as such.
SCALE_ALLOW = {'ms_mechs_s4', 'ms_tanks_s4'}

# Which model extent the class's `sizes` clearance row is authored against
# (_builder.lua header): hull length for vehicles/vessels, wingspan for air,
# ground extent for infantry/mechs/emplacements.
CLEARANCE_AXIS = {
    'tanks': 'z', 'artillery': 'z', 'ships': 'z', 'subs': 'z',
    'fighters': 'x', 'bombers': 'x',
    'soldiers': 'ground', 'engineers': 'ground', 'mechs': 'ground',
    'staticdefense': 'ground',
}
FORMATIONS = {'line', 'column', 'wedge', 'blob'}
BUILDER_CLASSES = set(SCALE_TABLE)
HARNESS_CLASSES = {'wz_baseline', 'fable_showcase'}
TEXTURE_MAPS = ('diffuse', 'orm', 'emissive', 'team', 'normals')

fails: list[str] = []
warns: list[str] = []
notes: list[str] = []


def fail(msg): fails.append(msg)
def warn(msg): warns.append(msg)
def note(msg): notes.append(msg)


# ─────────────────────────────────────────────────────────────── loading
def load_defs():
    proc = subprocess.run(
        ['lua', os.path.join(HERE, 'dump_defs.lua'), GAME],
        capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f'dump_defs.lua failed:\n{proc.stderr}')
    data = json.loads(proc.stdout)
    for e in data.get('errors', []):
        fail(f'def file failed to evaluate: {e}')
    return data


def lower_keys(d):
    """The engine lowercases every table key it reads; mirror that so a def
    authored `separationDistance` and one authored `separationdistance` are
    the same thing here too."""
    if isinstance(d, dict):
        return {str(k).lower(): lower_keys(v) for k, v in d.items()}
    if isinstance(d, list):
        return [lower_keys(v) for v in d]
    return d


def gltf_info(stem):
    p = os.path.join(GAME, 'models', stem + '.gltf')
    if not os.path.exists(p):
        return None
    with open(p) as f:
        doc = json.load(f)
    ext = doc.get('extensions', {}).get('SPRINGRTS_geometry', {})
    mins, maxs = ext.get('mins', [0, 0, 0]), ext.get('maxs', [0, 0, 0])
    dims = [(maxs[i] - mins[i]) / ELMOS_PER_METRE for i in range(3)]
    return {
        'path': p,
        'doc': doc,
        'dims': dims,                       # metres, x/y/z
        'ground': max(dims[0], dims[2]),
        'buffers': [b.get('uri') for b in doc.get('buffers', [])],
        'images': [i.get('uri') for i in doc.get('images', [])],
        'nodes': [n.get('name', '') for n in doc.get('nodes', [])],
        'clips': [a.get('name', '') for a in doc.get('animations', [])],
    }


# ─────────────────────────────────────────────────────────── ASSETS.md
def expand_braces(s):
    m = re.search(r'\{([^{}]*)\}', s)
    if not m:
        return [s]
    out = []
    for alt in m.group(1).split(','):
        out.extend(expand_braces(s[:m.start()] + alt.strip() + s[m.end():]))
    return out


def manifest_rows():
    rows = []
    with open(os.path.join(GAME, 'ASSETS.md')) as f:
        for ln, line in enumerate(f, 1):
            if not line.startswith('|'):
                continue
            cells = [c.strip().replace('\\|', '|')
                     for c in re.split(r'(?<!\\)\|', line.strip().strip('|'))]
            if len(cells) != 6 or cells[0].lower().startswith('asset') \
                    or all(re.fullmatch(r':?-+:?', c) for c in cells):
                continue
            rows.append((ln, cells))
    return rows


def manifest_coverage(rows):
    """Row line -> set of repo-relative (game-root) paths the row covers."""
    cover = {}
    for ln, cells in rows:
        raw = cells[0].replace('`', '')
        mods = cells[5]
        files = set()
        stems_gltf = []
        tokens = re.findall(r'[A-Za-z0-9_{},\-][A-Za-z0-9_./{},\-]*\.(?:gltf|ktx2|bin|webm|png)', raw)
        first_dir = None
        for tok in tokens:
            tok = tok.strip(',')
            for path in expand_braces(tok):
                if '/' in path:
                    first_dir = first_dir or os.path.dirname(path)
                else:
                    path = (first_dir or 'models') + '/' + path
                base = os.path.basename(path)
                # `+_{diffuse,...}.ktx2` / `{diffuse,...}.ktx2` → <stem>_<map>.ktx2
                mm = re.fullmatch(r'_?(' + '|'.join(TEXTURE_MAPS) + r')\.ktx2', base)
                if mm and stems_gltf:
                    for stem in stems_gltf:
                        files.add(f'{os.path.dirname(path)}/{stem}_{mm.group(1)}.ktx2')
                    continue
                files.add(path)
                if path.endswith('.gltf'):
                    stems_gltf.append(base[:-5])
        if '+.bin' in raw or '+.bin' in mods:
            for stem in stems_gltf:
                files.add(f'models/{stem}.bin')
        if re.search(r'\b5 \.ktx2', raw):
            for stem in stems_gltf:
                for m in TEXTURE_MAPS:
                    files.add(f'models/{stem}_{m}.ktx2')
        cover[ln] = files
    return cover


# ───────────────────────────────────────────────────────────── checks
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tables', action='store_true', help='print balance tables (markdown)')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--no-scale-gate', action='store_true',
                    help='skip running check_model_scale.py')
    args = ap.parse_args()

    data = load_defs()
    units_by_file = {f: lower_keys(v) for f, v in data['units'].items()}
    weapons = {}
    for f, tbl in data['weapons'].items():
        for name, wd in lower_keys(tbl).items():
            if name in weapons:
                fail(f'weapons/{f}: duplicate weapondef {name}')
            weapons[name] = wd
    features = {}
    for f, tbl in data['features'].items():
        for name, fd in lower_keys(tbl).items():
            features[name] = (f, fd)
    sounds = {k.lower(): lower_keys(v) for k, v in data['sounds'].items()}

    with open(os.path.join(GAME, 'effects', 'library.json')) as f:
        effects = set(json.load(f)['effects'])
    with open(os.path.join(GAME, 'effects', 'weapon-fx.json')) as f:
        weapon_fx = json.load(f)
    with open(os.path.join(GAME, 'effects', 'unit-fx.json')) as f:
        unit_fx = json.load(f)
    with open(os.path.join(GAME, 'ui', 'class-vocabulary.json')) as f:
        vocab_classes = set(json.load(f)['classes'])
    with open(os.path.join(GAME, 'gamedata', 'moveinfo.tdf')) as f:
        move_classes = {m.upper() for m in re.findall(r'name\s*=\s*(\w+)\s*;', f.read())}

    # flatten defs, detect duplicates across files
    defs = {}
    def_file = {}
    for f, tbl in sorted(units_by_file.items()):
        for name, d in tbl.items():
            lname = name.lower()
            if lname in defs:
                fail(f'units/{f}: def {name} already defined in units/{def_file[lname]}')
                continue
            defs[lname] = d
            def_file[lname] = f
    note(f'{len(defs)} unit defs in {len(units_by_file)} files; '
         f'{len(weapons)} weapondefs; {len(features)} featuredefs; {len(sounds)} SoundItems')

    categories = set()
    for d in defs.values():
        categories |= set(str(d.get('category', '')).upper().split())

    # ── sounds: files exist
    for key, item in sounds.items():
        fp = item.get('file')
        if not fp or not os.path.exists(os.path.join(GAME, fp)):
            fail(f'sounds.lua {key}: file {fp!r} missing')

    # ── weapons
    used_weapons = set()
    for wname, wd in weapons.items():
        ss = wd.get('soundstart')
        if ss:
            if ss.lower() not in sounds:
                fail(f'weapon {wname}: soundstart {ss!r} is not a SoundItem')
        dmg = (wd.get('damage') or {}).get('default', 0)
        rng = wd.get('range', 0)
        rel = wd.get('reloadtime', 0)
        if wname != 'noweapon':
            if not (dmg > 0 and rng > 0 and rel > 0):
                fail(f'weapon {wname}: damage/range/reload {dmg}/{rng}/{rel} not all > 0')
        res = (wd.get('customparams') or {}).get('resolution')
        if res not in ('statistical', 'ballistic', None):
            fail(f'weapon {wname}: unknown resolution {res!r}')
        if wd.get('weapontype', '').lower() == 'cannon' and res == 'ballistic':
            v = wd.get('weaponvelocity', 0)
            reach = v * v / GRAVITY
            if reach < rng:
                fail(f'weapon {wname}: ballistic Cannon v={v} reaches {reach:.0f} '
                     f'< declared range {rng} (v²/g rule, weapons.lua howitzer note)')
        # fx resolution
        wtype = wd.get('weapontype', '')
        entry = weapon_fx['weapons'].get(wname.upper())
        if entry is None:
            if wtype in weapon_fx['defaults']:
                warn(f'weapon {wname}: no weapon-fx.json entry, falls to the {wtype} default')
            else:
                fail(f'weapon {wname}: no weapon-fx.json entry and no {wtype!r} default')
    for wname, entry in weapon_fx['weapons'].items():
        if wname.lower() not in weapons:
            fail(f'weapon-fx.json names {wname}, which is not a weapondef')
        for slot in ('muzzle', 'projectile', 'trail', 'impact'):
            v = entry.get(slot)
            if v is not None and v not in effects:
                fail(f'weapon-fx.json {wname}.{slot}: effect {v!r} not in library.json')
        for slot in ('fireSound', 'impactSound'):
            v = entry.get(slot)
            if v is not None and v.lower() not in sounds:
                fail(f'weapon-fx.json {wname}.{slot}: {v!r} is not a SoundItem')
        fs = entry.get('fireSound')
        ws = weapons.get(wname.lower(), {}).get('soundstart')
        if fs and ws and fs.lower() != ws.lower():
            warn(f'weapon-fx.json {wname}.fireSound {fs!r} != weapons.lua soundstart {ws!r}')
    for key, entry in itertools.chain(weapon_fx['defaults'].items(),
                                      [('__fallback', weapon_fx['__fallback'])]):
        if key == '_doc':
            continue
        for slot in ('muzzle', 'projectile', 'trail', 'impact'):
            v = entry.get(slot)
            if v is not None and v not in effects:
                fail(f'weapon-fx.json defaults.{key}.{slot}: effect {v!r} not in library.json')

    # ── unit-fx. `sound` is a gamedata/sounds.lua SoundItem key (played by
    # unit-fx-dispatch.ts at the death position), a different namespace from
    # every other slot (a library.json effect name) — checked against
    # `sounds`, same as weapon-fx.json's fireSound/impactSound above.
    for cls, row in unit_fx['byClass'].items():
        for slot, v in row.items():
            if v is None:
                continue
            if slot == 'sound':
                if v.lower() not in sounds:
                    fail(f'unit-fx.json byClass.{cls}.sound: {v!r} is not a SoundItem')
            elif v not in effects:
                fail(f'unit-fx.json byClass.{cls}.{slot}: effect {v!r} not in library.json')
    for cls, scales in unit_fx['scaleOverrides'].items():
        if cls == '_doc':
            continue
        if cls not in unit_fx['byClass']:
            fail(f'unit-fx.json scaleOverrides.{cls}: no byClass row')
        for s, row in scales.items():
            for slot, v in row.items():
                if v is None:
                    continue
                if slot == 'sound':
                    if v.lower() not in sounds:
                        fail(f'unit-fx.json scaleOverrides.{cls}.{s}.sound: {v!r} is not a SoundItem')
                elif v not in effects:
                    fail(f'unit-fx.json scaleOverrides.{cls}.{s}.{slot}: {v!r} not in library.json')
    for dname, row in unit_fx['units'].items():
        if dname == '_doc':
            continue
        if dname.lower() not in defs:
            fail(f'unit-fx.json units.{dname}: not a def')
    for cls in BUILDER_CLASSES:
        if cls not in unit_fx['byClass']:
            fail(f'unit-fx.json byClass: builder class {cls!r} has no row')

    # ── models / per-def checks
    model_files = set(os.listdir(os.path.join(GAME, 'models')))
    referenced_models = set()
    display_names = {}
    scale_rows = []
    for dname, d in sorted(defs.items()):
        f = def_file[dname]
        cp = d.get('customparams') or {}
        cls = cp.get('ms_class')
        scale = cp.get('ms_scale')
        stem = d.get('objectname')
        impostor_only = str(cp.get('impostor_only', '')) not in ('', '0')

        # display names
        disp = d.get('name')
        if disp in display_names:
            warn(f'{dname}: display name {disp!r} duplicates {display_names[disp]}')
        else:
            display_names[disp] = dname

        # model
        info = None
        if not stem:
            if not impostor_only:
                fail(f'{dname}: no objectname and not impostor_only (placeholder shape)')
        else:
            info = gltf_info(stem)
            referenced_models.add(stem)
            if info is None:
                if not impostor_only:
                    fail(f'{dname}: objectname {stem!r} has no models/{stem}.gltf (placeholder shape)')
            else:
                for uri in info['buffers'] + info['images']:
                    if uri and uri not in model_files:
                        fail(f'{dname}: models/{stem}.gltf references missing {uri}')
        if cp.get('impostor_distance') or impostor_only:
            ist = stem or dname
            if f'{ist}_impostor.ktx2' not in model_files:
                fail(f'{dname}: impostor declared but models/{ist}_impostor.ktx2 missing')
            if str(cp.get('impostor_team_mask', '')) not in ('', '0') and \
                    f'{ist}_impostor_team.ktx2' not in model_files:
                fail(f'{dname}: impostor_team_mask set but models/{ist}_impostor_team.ktx2 missing')

        # weapons
        wlist = d.get('weapons') or []
        if isinstance(wlist, dict):
            wlist = [wlist[k] for k in sorted(wlist, key=lambda k: int(k))]
        for i, w in enumerate(wlist, 1):
            wn = (w.get('name') or w.get('def') or '') if isinstance(w, dict) else str(w)
            if wn.lower() not in weapons:
                fail(f'{dname}: weapon slot {i} names {wn!r}, not a weapondef')
            else:
                used_weapons.add(wn.lower())
            otc = w.get('onlytargetcategory') if isinstance(w, dict) else None
            if otc:
                for tok in str(otc).upper().split():
                    if tok not in categories:
                        fail(f'{dname}: weapon slot {i} onlytargetcategory {tok!r} '
                             f'matches no def category')
        canattack = d.get('canattack', True)
        if wlist and canattack is False:
            warn(f'{dname}: carries {len(wlist)} weapon(s) but canattack=false')
        if not wlist and canattack and d.get('canmove', True) \
                and cls not in ('civilians',):
            warn(f'{dname}: canattack (default true) with no weapons')

        # stats
        canmove = d.get('canmove', True)
        mv = d.get('maxvelocity', 0) or 0
        if canmove and mv <= 0:
            fail(f'{dname}: canmove but maxvelocity {mv}')
        if not canmove and mv > 0:
            fail(f'{dname}: immobile with maxvelocity {mv} (MoveTypeFactory assertion)')
        if (d.get('maxdamage') or 0) <= 0:
            fail(f'{dname}: maxdamage {d.get("maxdamage")}')
        if (d.get('mass') or 0) <= 0:
            warn(f'{dname}: mass {d.get("mass")} (engine default 1 — sway/transport math)')
        if canmove and not d.get('canfly'):
            mc = str(d.get('movementclass', '')).upper()
            if mc not in move_classes:
                fail(f'{dname}: movementclass {mc!r} not in moveinfo.tdf')
        if d.get('canfly') and not d.get('cruisealtitude'):
            warn(f'{dname}: canfly with no cruisealtitude (hugs the deck)')
        for bo in d.get('buildoptions') or []:
            if bo.lower() not in defs:
                fail(f'{dname}: buildoptions names {bo!r}, not a def')
        if d.get('isbuilding') and canmove:
            fail(f'{dname}: isbuilding and canmove')

        # customparams contract
        if cls is None:
            fail(f'{dname}: no customparams.ms_class')
        elif cls not in vocab_classes and cls not in HARNESS_CLASSES:
            warn(f'{dname}: ms_class {cls!r} has no ui/class-vocabulary.json entry')
        m = re.fullmatch(r'ms_([a-z]+)_s([1-4])', dname)
        if m and m.group(1) in BUILDER_CLASSES:
            if cls != m.group(1):
                fail(f'{dname}: ms_class {cls!r} != file class {m.group(1)!r}')
            if scale != m.group(2):
                fail(f'{dname}: ms_scale {scale!r} != {m.group(2)}')
            if m.group(2) == '4' and cp.get('squad_size') != '1':
                fail(f'{dname}: scale 4 must be a single hull, squad_size={cp.get("squad_size")}')
        ss = cp.get('squad_size')
        if ss is not None and (not str(ss).isdigit() or int(ss) < 1):
            fail(f'{dname}: squad_size {ss!r}')
        ft = cp.get('formation_type')
        if ft is not None and ft not in FORMATIONS:
            fail(f'{dname}: formation_type {ft!r} not in {sorted(FORMATIONS)}')
        if cls in BUILDER_CLASSES and canmove and 'member_clearance' not in cp:
            warn(f'{dname}: mobile builder def without member_clearance (pre-M2 spacing)')

        # scale vs DESIGN-GUIDE + clearance vs model
        if m and info and m.group(1) in SCALE_TABLE:
            axis, table = SCALE_TABLE[m.group(1)]
            s = int(m.group(2))
            want = table[s - 1]
            got = info['ground'] if axis == 'ground' else info['dims']['xyz'.index(axis)]
            scale_rows.append((dname, stem, axis, got, want))
            if want and abs(got - want) / want > SCALE_TOL and dname not in SCALE_ALLOW:
                warn(f'{dname}: model {stem} {axis}={got:.1f} m vs DESIGN-GUIDE {want} m '
                     f'({(got - want) / want:+.0%})')
            cax = CLEARANCE_AXIS.get(m.group(1))
            mc = cp.get('member_clearance')
            if cax and mc:
                clear_m = int(mc) * 2 / ELMOS_PER_METRE
                ext = info['ground'] if cax == 'ground' else info['dims']['xyz'.index(cax)]
                if ext > clear_m * 1.15:
                    warn(f'{dname}: member_clearance {clear_m:.1f} m < model {cax} extent '
                         f'{ext:.1f} m — members can interpenetrate')
                elif clear_m > ext * 1.6:
                    warn(f'{dname}: member_clearance {clear_m:.1f} m is {clear_m / ext:.1f}x '
                         f'the model {cax} extent {ext:.1f} m')
        # footprint vs ground extent, single hulls only
        if info and canmove and str(cp.get('squad_size', '1')) == '1':
            fp = max(d.get('footprintx', 0), d.get('footprintz', 0)) * 2
            if fp and info['ground'] > fp * 1.6:
                warn(f'{dname}: footprint {fp:.0f} m vs model ground extent {info["ground"]:.1f} m')

    for wname in weapons:
        if wname not in used_weapons and wname != 'noweapon':
            warn(f'weapon {wname}: defined but no unit carries it')

    # ── features
    for fname, (ff, fd) in sorted(features.items()):
        obj = fd.get('object')
        if not obj:
            fail(f'feature {fname}: no object')
        else:
            referenced_models.add(obj)
            if gltf_info(obj) is None:
                fail(f'feature {fname}: object {obj!r} has no models/{obj}.gltf')

    # ── orphan models (shipped, referenced by nothing) — review flag only
    all_stems = sorted(f[:-5] for f in model_files if f.endswith('.gltf'))
    orphans = [s for s in all_stems if s not in referenced_models and not s.startswith('ms_dress_')]
    if orphans:
        note(f'{len(orphans)} shipped models referenced by no def/feature: {", ".join(orphans)}')

    # ── ASSETS.md
    rows = manifest_rows()
    cover = manifest_coverage(rows)
    covered = {}
    for ln, files in cover.items():
        for p in files:
            if p in covered:
                warn(f'ASSETS.md line {ln}: {p} already covered by line {covered[p]}')
            else:
                covered[p] = ln
            if not os.path.exists(os.path.join(GAME, p)):
                fail(f'ASSETS.md line {ln}: names {p}, which is not on disk')
    for sub in ('models', 'unittextures', 'sounds'):
        for root, _, files in os.walk(os.path.join(GAME, sub)):
            for fn in files:
                if fn.endswith(('.md', '.txt', '.json')):
                    continue
                rel = os.path.relpath(os.path.join(root, fn), GAME)
                if rel not in covered:
                    fail(f'ASSETS.md: {rel} has no manifest row')

    # ── world-scale gate
    if not args.no_scale_gate:
        proc = subprocess.run([sys.executable, os.path.join(HERE, 'check_model_scale.py')],
                              capture_output=True, text=True, cwd=REPO)
        last = (proc.stdout.strip().splitlines() or [''])[-1]
        if proc.returncode != 0:
            fail(f'check_model_scale.py: {proc.stdout.strip()[:800]}')
        else:
            note(last)

    # ── output
    if args.tables:
        print_tables(defs, weapons, scale_rows)
    if not args.quiet:
        for n in notes:
            print('NOTE', n)
    for w in warns:
        print('WARN', w)
    for f in fails:
        print('FAIL', f)
    print(f'check_unit_defs: {len(fails)} FAIL, {len(warns)} WARN, {len(defs)} defs, '
          f'{len(weapons)} weapons, {len(features)} features')
    sys.exit(1 if fails else 0)


# ─────────────────────────────────────────────────────────────── tables
def weapon_dps(wd):
    dmg = (wd.get('damage') or {}).get('default', 0)
    rel = wd.get('reloadtime') or 1
    return dmg / rel


def print_tables(defs, weapons, scale_rows):
    print('\n## Weapons — damage, DPS, range\n')
    print('| weapon | type | resolution | dmg | reload s | DPS | range | AoE | vel |')
    print('|---|---|---|---:|---:|---:|---:|---:|---:|')
    for wn in sorted(weapons):
        wd = weapons[wn]
        if wn == 'noweapon':
            continue
        cp = wd.get('customparams') or {}
        print(f'| {wn.upper()} | {wd.get("weapontype")} | {cp.get("resolution")} | '
              f'{(wd.get("damage") or {}).get("default", 0):.0f} | {wd.get("reloadtime", 0):.1f} | '
              f'{weapon_dps(wd):.0f} | {wd.get("range", 0):.0f} | {wd.get("areaofeffect", 0):.0f} | '
              f'{wd.get("weaponvelocity", 0):.0f} |')

    print('\n## Builder classes — per-scale HP / speed / DPS / range\n')
    print('| def | members | HP (squad) | HP/member | speed e/s | turn | sight | DPS | max range | cost |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for cls in SCALE_TABLE:
        for s in range(1, 5):
            dn = f'ms_{cls}_s{s}'
            d = defs.get(dn)
            if not d:
                continue
            cp = d.get('customparams') or {}
            n = int(cp.get('squad_size', '1'))
            hp = d.get('maxdamage', 0)
            wl = d.get('weapons') or []
            if isinstance(wl, dict):
                wl = list(wl.values())
            dps = sum(weapon_dps(weapons[w['name'].lower()]) for w in wl
                      if isinstance(w, dict) and w.get('name', '').lower() in weapons)
            rng = max([weapons[w['name'].lower()].get('range', 0) for w in wl
                       if isinstance(w, dict) and w.get('name', '').lower() in weapons] or [0])
            print(f'| {dn} | {n} | {hp:.0f} | {hp / n:.0f} | {d.get("maxvelocity", 0) * 30:.0f} | '
                  f'{d.get("turnrate", 0):.0f} | {d.get("sightdistance", 0):.0f} | {dps:.0f} | '
                  f'{rng:.0f} | {cp.get("authority_cost_base", "")} |')

    print('\n## Shipped model vs DESIGN-GUIDE scale table\n')
    print('| def | model | axis | model m | table m | drift |')
    print('|---|---|---|---:|---:|---:|')
    for dn, stem, axis, got, want in scale_rows:
        drift = f'{(got - want) / want:+.0%}' if want else 'n/a'
        print(f'| {dn} | {stem} | {axis} | {got:.1f} | {want if want else "—"} | {drift} |')
    print()


if __name__ == '__main__':
    main()
