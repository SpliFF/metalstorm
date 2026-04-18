/* SpringMathCompat.h — math:: namespace compatibility
 *
 * Spring/Recoil code uses a math:: namespace prefix for math functions
 * (originally from streflop's deterministic FP library). Since we use
 * standard IEEE floating-point (server-authoritative, no P2P sync needed),
 * this header maps math:: directly to std::.
 */

#ifndef SPRING_MATH_COMPAT_H
#define SPRING_MATH_COMPAT_H

#include <cmath>
#include <limits>

namespace math {
    using std::floor;
    using std::ceil;
    using std::sin;
    using std::cos;
    using std::tan;
    using std::asin;
    using std::acos;
    using std::atan;
    using std::atan2;
    using std::log;
    using std::log2;
    using std::log10;
    using std::exp;
    using std::pow;
    using std::fmod;
    using std::fabs;
    using std::abs;
    using std::frexp;
    using std::ldexp;
    using std::modf;
    using std::isfinite;
    using std::isnan;
    using std::isinf;
    using std::copysign;
    using std::signbit;
    using std::hypot;
    using std::remainder;
    using std::sinh;
    using std::cosh;
    using std::tanh;
    using std::erf;
    using std::erfc;
    // sqrt provided by FastMath.h (overrides with faster implementation)
    using std::cbrt;
    using std::round;
    using std::trunc;

    inline float fabsf(float x) { return std::fabs(x); }
    inline float sinf(float x) { return std::sin(x); }
    inline float cosf(float x) { return std::cos(x); }
    inline float tanf(float x) { return std::tan(x); }
    inline float acosf(float x) { return std::acos(x); }
    inline float asinf(float x) { return std::asin(x); }
    inline float atanf(float x) { return std::atan(x); }
    // sqrtf provided by FastMath.h

    static constexpr float SimplePositiveInfinity = std::numeric_limits<float>::infinity();
    static constexpr float SimpleNegativeInfinity = -std::numeric_limits<float>::infinity();
    static constexpr float SimplePositiveInfinityf = std::numeric_limits<float>::infinity();
    static constexpr double DoublePositiveInfinity = std::numeric_limits<double>::infinity();
}

namespace streflop {
    struct Simple {};
    struct Double {};

    template<typename T>
    inline void streflop_init() {}
}

#endif
