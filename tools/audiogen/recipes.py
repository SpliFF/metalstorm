"""recipes.py — per-category layer recipes consumed by build.py.

Each function returns (layers, duration, post) for one manifest entry's
"close" rendering; build.py derives the "_far" pair automatically via
synth.derive_far. Kept separate from build.py so the sound-design choices
(frequencies, envelopes) are easy to scan/retune without touching the
pipeline plumbing.
"""
from __future__ import annotations

from synth import Layer


def weapon_mg_volley():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.42, gain_db=-6,
              hp=800, lp=4500, attack=0.001, release=0.03, delay_ms=d)
        for d in (0, 55, 110, 165, 220)
    ]
    layers.append(Layer(kind="noise", noise_color="brown", duration=0.42,
                         gain_db=-14, hp=120, lp=400, attack=0.002, release=0.35))
    return layers, 0.42, {"post_hp": 100}


def weapon_autocannon():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.5, gain_db=-3,
              hp=150, lp=2200, attack=0.001, release=0.06),
        Layer(kind="tone", freq=95, freq_to=55, duration=0.5, gain_db=-4,
              attack=0.002, release=0.4),
    ]
    return layers, 0.5, {"post_hp": 40}


def weapon_railgun():
    layers = [
        Layer(kind="tone", freq=3400, freq_to=180, duration=0.18, gain_db=-4,
              attack=0.001, release=0.16),
        Layer(kind="noise", noise_color="white", duration=0.18, gain_db=-6,
              hp=2200, attack=0.001, release=0.1),
        Layer(kind="noise", noise_color="white", duration=0.6, gain_db=-16,
              hp=1000, lp=5000, attack=0.05, release=0.55, delay_ms=30),
    ]
    return layers, 0.6, {"post_hp": 80}


def weapon_mortar():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=0.7, gain_db=-4,
              lp=280, attack=0.003, release=0.6),
        Layer(kind="tone", freq=62, freq_to=40, duration=0.7, gain_db=-6,
              attack=0.004, release=0.55),
        Layer(kind="noise", noise_color="white", duration=0.7, gain_db=-12,
              hp=1200, lp=4500, attack=0.001, release=0.08),
    ]
    return layers, 0.7, {"post_lp": 6000}


def weapon_howitzer():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=1.3, gain_db=-2,
              lp=200, attack=0.004, release=1.2),
        Layer(kind="tone", freq=48, freq_to=32, duration=1.3, gain_db=-4,
              attack=0.005, release=1.1),
        Layer(kind="noise", noise_color="white", duration=1.3, gain_db=-10,
              hp=1500, lp=5000, attack=0.001, release=0.1),
    ]
    return layers, 1.3, {"post_lp": 6500}


def weapon_missile_launch(size: float = 1.0):
    d = 1.5 * size
    layers = [
        Layer(kind="noise", noise_color="pink", duration=d, gain_db=-6,
              hp=300, lp=3200, attack=0.15 * size, release=d - 0.15 * size),
        Layer(kind="tone", freq=180, freq_to=520, duration=0.4 * size, gain_db=-9,
              attack=0.02, release=0.35 * size),
        Layer(kind="noise", noise_color="brown", duration=d, gain_db=-8,
              lp=700, attack=0.05, release=d - 0.05, delay_ms=60),
    ]
    return layers, d, {"post_hp": 60}


def weapon_torpedo():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=0.8, gain_db=-4,
              lp=500, attack=0.003, release=0.6),
        Layer(kind="tone", freq=70, duration=0.4, gain_db=-8,
              attack=0.005, release=0.3),
        Layer(kind="noise", noise_color="white", duration=0.5, gain_db=-14,
              hp=2000, lp=6000, attack=0.001, release=0.4, delay_ms=100),
    ]
    return layers, 0.8, {"post_lp": 5000}


def weapon_flak():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.5, gain_db=-4,
              hp=2200, attack=0.001, release=0.02, delay_ms=d)
        for d in (0, 70, 150)
    ]
    layers.append(Layer(kind="noise", noise_color="white", duration=0.5,
                         gain_db=-10, hp=400, lp=2500, attack=0.002, release=0.4))
    return layers, 0.5, {"post_hp": 200}


def weapon_bomb_release():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.15, gain_db=-8,
              hp=600, lp=2200, attack=0.001, release=0.1),
        Layer(kind="tone", freq=420, freq_to=140, duration=0.5, gain_db=-10,
              attack=0.005, release=0.45),
    ]
    return layers, 0.6, {"post_hp": 80}


def weapon_depthcharge():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.12, gain_db=-8,
              hp=700, lp=2500, attack=0.001, release=0.08),
        Layer(kind="tone", freq=85, duration=0.35, gain_db=-9,
              attack=0.005, release=0.3),
        Layer(kind="noise", noise_color="brown", duration=0.6, gain_db=-13,
              lp=350, attack=0.05, release=0.5, delay_ms=120),
    ]
    return layers, 0.7, {"post_hp": 40}


def weapon_cruise_launch():
    layers, d, post = weapon_missile_launch(size=1.35)
    return layers, d, post


# ---- impacts ---------------------------------------------------------

def impact_metal(pitch: float, dur: float, gain_db: float):
    layers = [
        Layer(kind="tone", freq=pitch, duration=dur, gain_db=gain_db,
              attack=0.001, release=dur - 0.02, release_curve="exp"),
        Layer(kind="noise", noise_color="white", duration=dur, gain_db=gain_db - 2,
              hp=2000, attack=0.001, release=0.04),
    ]
    return layers, dur, {"post_hp": 150}


def impact_dirt(dur: float, gain_db: float):
    layers = [
        Layer(kind="noise", noise_color="brown", duration=dur, gain_db=gain_db,
              lp=350, attack=0.002, release=dur - 0.02),
    ]
    return layers, dur, {"post_lp": 3000}


def impact_water(dur: float, gain_db: float):
    layers = [
        Layer(kind="noise", noise_color="white", duration=dur, gain_db=gain_db,
              hp=500, lp=4000, attack=0.001, release=dur * 0.5),
        Layer(kind="noise", noise_color="white", duration=dur, gain_db=gain_db - 6,
              hp=3000, attack=0.02, release=dur - 0.02, delay_ms=30),
    ]
    return layers, dur, {"post_hp": 200}


def impact_rail():
    layers = [
        Layer(kind="tone", freq=2600, freq_to=900, duration=0.22, gain_db=-6,
              attack=0.001, release=0.2),
        Layer(kind="noise", noise_color="white", duration=0.22, gain_db=-8,
              hp=2500, attack=0.001, release=0.05),
    ]
    return layers, 0.22, {"post_hp": 300}


def impact_shield():
    layers = [
        Layer(kind="tone", freq=1800, freq_to=2600, duration=0.3, gain_db=-8,
              attack=0.002, release=0.26),
        Layer(kind="noise", noise_color="white", duration=0.3, gain_db=-12,
              hp=3200, attack=0.001, release=0.15),
    ]
    return layers, 0.3, {"post_hp": 500}


# ---- explosions --------------------------------------------------------

def explosion(lp: float, dur: float, gain_db: float, tone_f0: float, tone_f1: float,
              bright: bool = False):
    layers = [
        Layer(kind="noise", noise_color="brown" if not bright else "pink",
              duration=dur, gain_db=gain_db, lp=lp, attack=0.003, release=dur - 0.05),
        Layer(kind="tone", freq=tone_f0, freq_to=tone_f1, duration=dur * 0.7,
              gain_db=gain_db - 3, attack=0.004, release=dur * 0.6),
        Layer(kind="noise", noise_color="white", duration=dur, gain_db=gain_db - 8,
              hp=1500, lp=6000, attack=0.001, release=0.06),
    ]
    return layers, dur, {"post_lp": 7000 if bright else 5000}


# ---- deaths --------------------------------------------------------

def death_infantry():
    layers = [
        Layer(kind="noise", noise_color="white", duration=0.4, gain_db=-6,
              hp=800, lp=3200, attack=0.001, release=0.1),
        Layer(kind="noise", noise_color="brown", duration=0.4, gain_db=-12,
              lp=300, attack=0.002, release=0.3),
    ]
    return layers, 0.4, {"post_hp": 100}


def death_vehicle_light():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=0.6, gain_db=-4,
              lp=550, attack=0.002, release=0.5),
        Layer(kind="tone", freq=520, duration=0.35, gain_db=-9,
              attack=0.001, release=0.3),
    ]
    return layers, 0.6, {"post_lp": 5000}


def death_vehicle_heavy():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=1.3, gain_db=-2,
              lp=280, attack=0.004, release=1.2),
        Layer(kind="tone", freq=300, freq_to=75, duration=1.1, gain_db=-7,
              attack=0.01, release=1.0),
        Layer(kind="noise", noise_color="white", duration=1.3, gain_db=-11,
              hp=1200, lp=4000, attack=0.001, release=0.1),
    ]
    return layers, 1.3, {"post_lp": 6000}


def death_aircraft():
    layers = [
        Layer(kind="tone", freq=800, freq_to=180, duration=1.0, gain_db=-8,
              attack=0.02, release=0.9),
        Layer(kind="noise", noise_color="brown", duration=0.7, gain_db=-4,
              lp=350, attack=0.005, release=0.6, delay_ms=900),
    ]
    return layers, 1.6, {"post_lp": 6000}


def death_ship():
    layers = [
        Layer(kind="tone", freq=150, freq_to=48, duration=1.2, gain_db=-7,
              attack=0.03, release=1.1),
        Layer(kind="noise", noise_color="pink", duration=1.2, gain_db=-10,
              hp=300, lp=2000, attack=0.05, release=1.0),
        Layer(kind="noise", noise_color="white", duration=0.7, gain_db=-8,
              hp=500, lp=4000, attack=0.02, release=0.6, delay_ms=1100),
    ]
    return layers, 1.8, {"post_hp": 40}


def death_building():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=1.4, gain_db=-3,
              lp=250, attack=0.005, release=1.3),
    ]
    for i, d in enumerate((200, 500, 800, 1150)):
        layers.append(Layer(kind="noise", noise_color="white", duration=0.3,
                             gain_db=-12 - i, hp=1200, lp=4500,
                             attack=0.001, release=0.25, delay_ms=d))
    return layers, 1.6, {"post_lp": 6000}


# ---- unit loops --------------------------------------------------

def unit_engine_run():
    layers = [
        Layer(kind="noise", noise_color="brown", duration=8.0, gain_db=-16,
              lp=350, attack=1.0, release=6.5),
        Layer(kind="tone", freq=52, duration=8.0, gain_db=-20,
              attack=1.0, release=6.5),
    ]
    return layers, 8.0, {"post_lp": 2500}


# ---- ambience beds --------------------------------------------------

def ambience_wind(character: str):
    """`character` in {open, valley, urban} — reuses the reverb-preset
    vocabulary so ambience and room tone read as the same three biomes."""
    if character == "open":
        layers = [Layer(kind="noise", noise_color="pink", duration=20.0,
                         gain_db=-14, hp=200, lp=4000, attack=2.0, release=18.0)]
    elif character == "valley":
        layers = [
            Layer(kind="noise", noise_color="pink", duration=20.0, gain_db=-15,
                  hp=150, lp=3000, attack=2.0, release=18.0),
            Layer(kind="noise", noise_color="pink", duration=20.0, gain_db=-22,
                  hp=150, lp=2200, attack=2.0, release=18.0, delay_ms=400),
        ]
    else:  # urban
        layers = [
            Layer(kind="noise", noise_color="pink", duration=20.0, gain_db=-16,
                  hp=300, lp=2500, attack=2.0, release=18.0),
            Layer(kind="tone", freq=900, duration=1.2, gain_db=-24,
                  attack=0.3, release=0.8, delay_ms=6000),
            Layer(kind="tone", freq=1200, duration=1.0, gain_db=-26,
                  attack=0.3, release=0.6, delay_ms=13500),
        ]
    return layers, 20.0, {}


def ambience_dust_gust(character: str):
    gust_delays = (0, 5200, 10800) if character != "urban" else (0, 4800, 9600, 13200)
    layers = []
    for i, d in enumerate(gust_delays):
        layers.append(Layer(kind="noise", noise_color="brown", duration=3.0,
                             gain_db=-10 - (i % 2), lp=1500 if character != "open" else 2000,
                             attack=1.0, release=1.8, delay_ms=d))
    if character == "urban":
        for i, d in enumerate((700, 6100, 10500)):
            layers.append(Layer(kind="noise", noise_color="white", duration=0.15,
                                 gain_db=-20, hp=3000, attack=0.001, release=0.1,
                                 delay_ms=d))
    return layers, 15.0, {"post_lp": 3500}


def ambience_artillery(character: str):
    boom_delays = (500, 7200, 14500, 22000, 27500)
    layers = []
    for i, d in enumerate(boom_delays):
        rel = 1.8 if character == "valley" else (1.1 if character == "urban" else 0.9)
        layers.append(Layer(kind="noise", noise_color="brown", duration=1.0,
                             gain_db=-16 - (i % 3), lp=260, attack=0.01, release=rel,
                             delay_ms=d))
        if character == "urban":
            layers.append(Layer(kind="noise", noise_color="white", duration=0.4,
                                 gain_db=-24, hp=2500, attack=0.02, release=0.35,
                                 delay_ms=d + 120))
    return layers, 30.0, {"post_lp": 5000}


# ---- UI --------------------------------------------------------------

def ui_open():
    return [Layer(kind="tone", freq=420, freq_to=920, duration=0.16, gain_db=-8,
                   attack=0.005, release=0.13)], 0.16, {}


def ui_close():
    return [Layer(kind="tone", freq=920, freq_to=420, duration=0.16, gain_db=-8,
                   attack=0.005, release=0.13)], 0.16, {}


def ui_confirm():
    layers = [
        Layer(kind="tone", freq=660, duration=0.09, gain_db=-8, attack=0.003, release=0.07),
        Layer(kind="tone", freq=880, duration=0.11, gain_db=-8, attack=0.003, release=0.09, delay_ms=100),
    ]
    return layers, 0.22, {}


def ui_refuse():
    layers = [
        Layer(kind="tone", freq=220, duration=0.1, gain_db=-8, attack=0.002, release=0.08),
        Layer(kind="tone", freq=180, duration=0.12, gain_db=-8, attack=0.002, release=0.1, delay_ms=130),
    ]
    return layers, 0.26, {}


def ui_notice():
    return [Layer(kind="tone", freq=700, duration=0.2, gain_db=-9,
                   attack=0.02, release=0.16)], 0.2, {}


# ---- music (calm/tension/battle, ~90-120s loops) ---------------------

def _pad(freqs: list[float], duration: float, gain_db: float):
    return [Layer(kind="tone", freq=f, duration=duration, gain_db=gain_db,
                   attack=3.0, release=duration - 3.0) for f in freqs]


def music_calm():
    d = 100.0
    layers = _pad([110, 165, 220], d, -20)
    for i, delay in enumerate((15000, 42000, 71000)):
        layers.append(Layer(kind="tone", freq=880, duration=1.2, gain_db=-22,
                             attack=0.05, release=1.0, delay_ms=delay))
    return layers, d, {"post_lp": 5000}


def music_tension():
    d = 100.0
    layers = _pad([98, 103, 196], d, -19)
    for i, delay in enumerate(range(2000, 96000, 5000)):
        if i % 3 == 0:
            continue  # irregular, not a metronome
        layers.append(Layer(kind="noise", noise_color="brown", duration=0.5,
                             gain_db=-18, lp=300, attack=0.01, release=0.4,
                             delay_ms=delay))
    return layers, d, {"post_lp": 6000}


def music_battle():
    d = 110.0
    layers = _pad([98, 147, 196], d, -17)
    for delay in range(1000, 108000, 1400):
        layers.append(Layer(kind="noise", noise_color="brown", duration=0.35,
                             gain_db=-16, lp=350, attack=0.005, release=0.3,
                             delay_ms=delay))
    for delay in range(3000, 105000, 9000):
        layers.append(Layer(kind="tone", freq=220, freq_to=180, duration=0.5,
                             gain_db=-15, hp=150, lp=1200, attack=0.01, release=0.45,
                             delay_ms=delay))
    return layers, d, {"post_lp": 7000}


# ---- reverb IRs (open/valley/urban) -----------------------------------

def reverb_ir(character: str):
    if character == "open":
        layers = [Layer(kind="noise", noise_color="white", duration=0.4, gain_db=-3,
                         hp=200, attack=0.001, release=0.38)]
        return layers, 0.4, {"post_lp": 8000}
    if character == "valley":
        layers = [Layer(kind="noise", noise_color="white", duration=2.5, gain_db=-4,
                         hp=100, attack=0.001, release=2.45)]
        for d in (40, 90, 160, 260):
            layers.append(Layer(kind="noise", noise_color="white", duration=0.15,
                                 gain_db=-10, hp=150, attack=0.001, release=0.13,
                                 delay_ms=d))
        return layers, 2.5, {"post_lp": 6000}
    # urban: dense early reflections, comb-y
    layers = [Layer(kind="noise", noise_color="white", duration=1.0, gain_db=-4,
                     hp=150, attack=0.001, release=0.95)]
    for d in (5, 11, 17, 23, 31, 42, 58):
        layers.append(Layer(kind="noise", noise_color="white", duration=0.1,
                             gain_db=-9, hp=2000, lp=5000, attack=0.001, release=0.09,
                             delay_ms=d))
    return layers, 1.0, {"post_lp": 5500}
