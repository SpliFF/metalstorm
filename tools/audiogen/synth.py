"""synth.py — ffmpeg-only layered audio synthesis primitives.

TOOLING GAP: the brief asks for "ffmpeg+sox"; sox is not installed on this
machine (brew has no sox formula bottle pulled in) and installing packages
is outside this lane's scope. Every operation sox would have done (trim,
layer/mix, EQ, envelope, resample) has a direct ffmpeg filtergraph
equivalent, used exclusively below. Nothing here is a stand-in — it is a
complete substitute achieving the same result.

A "layer" is one lavfi-generated mono source (noise burst, tone, or linear
frequency sweep) shaped by an attack/release envelope, optional
highpass/lowpass, gain, and a start delay. `render_layers` mixes N layers
into one WAV of an exact duration. Recipes in recipes.py compose layers;
build.py renders manifest entries.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

SR = 48000  # project-wide sample rate for all synthesis intermediates


def _ffmpeg_bin() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg not found on PATH — required by tools/audiogen")
    return exe


@dataclass
class Layer:
    """One synthesized voice mixed into a sound. Exactly one of
    (`noise`, `freq`) must be set; `freq_to` turns a tone into a linear
    sweep (a "zap"/"whoosh").
    """
    kind: str  # "noise" | "tone"
    duration: float
    noise_color: str = "white"      # white | pink | brown
    freq: float = 440.0
    freq_to: float | None = None    # sweep end frequency
    gain_db: float = 0.0
    delay_ms: float = 0.0
    attack: float = 0.003
    release: float | None = None    # defaults to duration - attack
    release_curve: str = "exp"      # ffmpeg afade curve name
    hp: float | None = None
    lp: float | None = None

    def source_filter(self) -> str:
        d = self.duration
        if self.kind == "noise":
            return f"anoisesrc=color={self.noise_color}:duration={d:.4f}:sample_rate={SR}:amplitude=1"
        if self.kind == "tone":
            if self.freq_to is not None:
                f0, f1 = self.freq, self.freq_to
                expr = f"sin(2*PI*({f0}*t+({f1}-{f0})*t*t/(2*{d:.4f})))"
                return f"aevalsrc=exprs='{expr}':duration={d:.4f}:sample_rate={SR}"
            return f"sine=frequency={self.freq}:duration={d:.4f}:sample_rate={SR}"
        raise ValueError(f"unknown layer kind {self.kind!r}")

    def filter_chain(self, label_in: str, label_out: str) -> str:
        rel = self.release if self.release is not None else max(self.duration - self.attack, 0.01)
        st = max(self.duration - rel, 0.0)
        gain_lin = 10 ** (self.gain_db / 20.0)
        parts = [f"[{label_in}]"]
        chain: list[str] = []
        if self.hp:
            chain.append(f"highpass=f={self.hp}")
        if self.lp:
            chain.append(f"lowpass=f={self.lp}")
        chain.append(f"afade=t=in:st=0:d={self.attack:.4f}:curve=tri")
        chain.append(f"afade=t=out:st={st:.4f}:d={rel:.4f}:curve={self.release_curve}")
        chain.append(f"volume={gain_lin:.6f}")
        if self.delay_ms > 0:
            chain.append(f"adelay={self.delay_ms:.1f}:all=1")
        return "".join(parts) + ",".join(chain) + f"[{label_out}]"


def render_layers(layers: list[Layer], duration: float, out_wav: Path,
                   post_hp: float | None = None, post_lp: float | None = None,
                   post_gain_db: float = 0.0, channels: int = 1) -> None:
    """Mix `layers` and write an exact-`duration` WAV to `out_wav`."""
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    inputs: list[str] = []
    chains: list[str] = []
    mix_labels: list[str] = []
    for i, layer in enumerate(layers):
        inputs += ["-f", "lavfi", "-i", layer.source_filter()]
        lbl = f"L{i}"
        chains.append(layer.filter_chain(str(i) + ":a", lbl))
        mix_labels.append(f"[{lbl}]")
    mix = "".join(mix_labels) + f"amix=inputs={len(layers)}:normalize=0:duration=longest[mixed]"
    post: list[str] = []
    if post_hp:
        post.append(f"highpass=f={post_hp}")
    if post_lp:
        post.append(f"lowpass=f={post_lp}")
    post_gain_lin = 10 ** (post_gain_db / 20.0)
    post.append(f"volume={post_gain_lin:.6f}")
    post.append(f"atrim=0:{duration:.4f}")
    post.append(f"apad=whole_dur={duration:.4f}")
    # Generous headroom below the sample peak: the *final* true-peak number
    # that matters is measured on the Opus-encoded .webm (audio-loudness.md),
    # and lossy re-synthesis of sharp transients (clicks/cracks) routinely
    # overshoots the source PCM peak by several dB — empirically up to ~4 dB
    # on the flak/mg/railgun click layers. limit=0.5 (~-6 dBFS pre-encode)
    # is what keeps the post-encode true peak under the -1 dBTP target
    # (PLAN-audio.md mix-pass). level=disabled: don't let alimiter's
    # auto-gain-match push quiet layers back up.
    post.append("alimiter=limit=0.5:level=disabled")
    if channels == 2:
        post.append("pan=stereo|c0=c0|c1=c0")
    filt = ";".join(chains) + ";" + mix + ";[mixed]" + ",".join(post) + "[out]"
    cmd = [_ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
           *inputs, "-filter_complex", filt, "-map", "[out]",
           "-ar", str(SR), str(out_wav)]
    subprocess.run(cmd, check=True)


def apply_radio_filter(in_wav: Path, out_wav: Path) -> None:
    """Bandpass + gentle bitcrush — the 'radio-filtered mechanical UI' art
    direction. Reused for every UI sound key."""
    cmd = [_ffmpeg_bin(), "-hide_banner", "-loglevel", "error", "-y",
           "-i", str(in_wav), "-af",
           "highpass=f=500,lowpass=f=3200,acrusher=bits=10:mode=log:aa=1",
           "-ar", str(SR), str(out_wav)]
    subprocess.run(cmd, check=True)


def derive_far(layers: list[Layer], extra_delay_ms: float = 0.0) -> list[Layer]:
    """Distance-switched variant of a close layer set: quieter, muffled,
    slightly longer tail — the `_far` half of every close/_far pair
    (sounds.lua switches between them at ~900 elmos)."""
    far: list[Layer] = []
    for layer in layers:
        clone = Layer(**{**layer.__dict__})
        clone.gain_db -= 9.0
        clone.lp = min(clone.lp, 1800) if clone.lp else 1800
        if clone.release is not None:
            clone.release *= 1.35
        clone.delay_ms += extra_delay_ms
        far.append(clone)
    return far


def ebur128_report(in_file: Path) -> dict:
    """Run ffmpeg's ebur128 filter and parse the integrated-loudness / true-
    peak summary it prints at the end of the pass. Returns
    {integrated_lufs, true_peak_dbtp, lra} or {} if parsing fails (e.g. a
    clip too short for a stable integrated measurement)."""
    cmd = [_ffmpeg_bin(), "-hide_banner", "-nostats", "-i", str(in_file),
           "-af", "ebur128=peak=true", "-f", "null", "-"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    text = proc.stderr
    out: dict = {}
    import re
    m = re.search(r"Integrated loudness:\s*\n\s*I:\s*(-?\d+\.?\d*)\s*LUFS", text)
    if m:
        out["integrated_lufs"] = float(m.group(1))
    m = re.search(r"LRA:\s*(-?\d+\.?\d*)\s*LU", text)
    if m:
        out["lra"] = float(m.group(1))
    m = re.search(r"True peak:\s*\n\s*Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
    if m:
        out["true_peak_dbtp"] = float(m.group(1))
    return out
