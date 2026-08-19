/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef DETAIL_TEX_DC_H
#define DETAIL_TEX_DC_H

#include <cstdint>

/**
 * The DC (mean) of a near-field detail texture, and why it is a content
 * property rather than a rendering one.
 *
 * Recoil's `GetDetailTextureColor` adds the detail sample *signed*:
 * `baseColor.rgb += texture(detailTex, uv).rgb * 2.0 - 1.0`, with no fade
 * uniform anywhere in SMFFragProg. The distance falloff is therefore the mip
 * chain and nothing else: as the chain averages, the texture's *grain* washes
 * out towards its mean and stops contributing. Its *mean* does not wash out —
 * the 1x1 top mip is a constant that survives every distance, so a detail
 * texture whose mean is not mid-grey tints the entire map by a fixed amount,
 * forever, at every zoom. Measured live in PLAN-maps.md M8h:
 * `techno_lands_final_2.60_wide` renders ~2-3 luminance levels darker than its
 * own albedo because its `detailTex` mean is 126.2 rather than 127.5.
 *
 * Two consequences this header exists to encode:
 *
 * 1. **Mid-grey is 127.5, not 128.** `x * 2 - 1 == 0` at `x == 0.5`, which in
 *    8-bit is 127.5 — a value no single texel can hold. A texture authored at
 *    a flat 128 still carries +1.1 levels of permanent brightening; only the
 *    *mean* can land on 127.5 (e.g. equal populations of 127 and 128).
 * 2. **The mip filter must round to nearest *even*, not truncate.** Integer
 *    `(a+b+c+d)/4` biases every level down by up to 0.75 of a level and the
 *    bias compounds over the chain — measured at roughly -3 levels across 9
 *    levels, i.e. larger than the authoring error it hides. Plain
 *    round-half-up still leaves ~+0.9 (every exact `.5` goes the same way, nine
 *    times over). `MipBoxAvg4` breaks ties to even, so a DC-neutral source
 *    stays DC-neutral all the way to the 1x1, where the only residue left is
 *    the ±0.5 of storing a single texel.
 *
 * Header-only and dependency-free on purpose, for the same reason as
 * Ktx2Orientation.h: `textureconverter` links libktx and `spring-tests` does
 * not, so the filter and the tolerance have to live somewhere both include.
 */
namespace detailtex {

/// One 2x2 box-filter texel, rounded half-to-even. Inputs are 0..255 channel
/// samples; the result is the texel one mip level below them. Ties-to-even
/// rather than ties-up because the chain applies this up to a dozen times and
/// any fixed tie direction is a bias that compounds (see the header comment).
constexpr uint8_t MipBoxAvg4(int a, int b, int c, int d) {
	const int sum = a + b + c + d;
	const int q = sum >> 2;
	const int r = sum & 3;
	if (r > 2) return static_cast<uint8_t>(q + 1);
	if (r < 2) return static_cast<uint8_t>(q);
	return static_cast<uint8_t>(q + (q & 1)); // exact .5 -> nearest even
}

/// The constant the terrain shader adds for a texture whose channel mean is
/// `mean255` — Recoil's `tex * 2 - 1`, in 0..1 output units.
constexpr double SignedDcFromMean(double mean255) {
	return 2.0 * (mean255 / 255.0) - 1.0;
}

/// The same shift expressed in 8-bit output levels, which is how it reads on
/// screen and in a screenshot statistic.
constexpr double DcInLevels(double signedDc) {
	return signedDc * 255.0;
}

/// The channel mean that adds exactly nothing: 127.5, not 128.
inline constexpr double kNeutralMean = 127.5;

/// How far off neutral a `detailTex` may sit before it is worth telling the
/// map author about. Two 8-bit levels of permanent, distance-invariant tint:
/// below this the shift is inside the dither of any real ground texture, and
/// a texture authored at a flat 128 (the closest a constant can get to
/// neutral, +1.1 levels) must not trip the warning. `techno_lands`'s -2.7 does.
inline constexpr double kDcToleranceLevels = 2.0;

/// True if a channel mean is neutral enough to leave alone.
constexpr bool IsDcNeutral(double mean255) {
	const double levels = DcInLevels(SignedDcFromMean(mean255));
	return levels >= -kDcToleranceLevels && levels <= kDcToleranceLevels;
}

} // namespace detailtex

#endif // DETAIL_TEX_DC_H
