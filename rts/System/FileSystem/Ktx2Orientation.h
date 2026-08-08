/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef KTX2_ORIENTATION_H
#define KTX2_ORIENTATION_H

#include <string_view>

/**
 * The `KTXorientation` key/value every KTX2 file this project writes
 * carries, plus the spec grammar that validates it.
 *
 * KTX2 §3.11.4 defines the value as one letter per texture dimension:
 * `/^[rl]$/` for 1D, `/^[rl][du]$/` for 2D, `/^[rl][du][oi]$/` for 3D.
 * This is NOT libktx's KTX**1** spelling — `KTX_ORIENTATION2_FMT` is
 * `"S=%c,T=%c"`, and a KTX2 file carrying `S=r,T=d` is invalid: the
 * Khronos `ktx` CLI rejects it with error-7108 (dimension count) and
 * error-7109 (letter grammar), so `ktx validate`, `ktx info` and
 * `ktx extract` all refuse to open the file. Nothing renders wrong —
 * neither Babylon's KTX2 loader nor basisu reads the key — but it costs
 * every future asset investigation the standard tooling. See
 * PLAN-maps.md M8e/M8f.
 *
 * Header-only and dependency-free on purpose: `textureconverter` links
 * libktx and `spring-tests` does not, so the constant and its validator
 * have to live somewhere both can include.
 */
namespace ktx2 {

/// Row order every output path in `textureconverter` produces: origin
/// top-left, V increasing downwards (the glTF 2.0 convention).
inline constexpr char kOrientation2D[] = "rd";

/// True if `value` is a spec-legal `KTXorientation` for a texture of
/// `dimensions` dimensions (1, 2 or 3). Mirrors the KTX2 §3.11.4
/// grammar the Khronos validator enforces.
constexpr bool IsValidOrientation(std::string_view value, int dimensions) {
	if (dimensions < 1 || dimensions > 3) return false;
	if (value.size() != static_cast<size_t>(dimensions)) return false;
	if (value[0] != 'r' && value[0] != 'l') return false;
	if (dimensions >= 2 && value[1] != 'd' && value[1] != 'u') return false;
	if (dimensions >= 3 && value[2] != 'o' && value[2] != 'i') return false;
	return true;
}

} // namespace ktx2

#endif // KTX2_ORIENTATION_H
