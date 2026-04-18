/**
 * streflop replacement stub
 *
 * Spring's Lua was patched to use streflop for deterministic FP math.
 * Since we've removed streflop (server-authoritative model doesn't need
 * cross-build FP reproducibility), this header redirects to standard math.
 *
 * The Spring Lua patches use a 'math::' namespace prefix for math functions.
 * We provide that namespace as a passthrough to std:: functions.
 */

#ifndef STREFLOP_COND_H
#define STREFLOP_COND_H

#include <cmath>
#include <limits>

namespace math {
    using std::floor;
    using std::ceil;
    // Note: sqrt is intentionally omitted — FastMath.h defines an optimised
    // version in the math:: namespace that overrides it.
    using std::sin;
    using std::cos;
    using std::tan;
    using std::asin;
    using std::acos;
    using std::atan;
    using std::atan2;
    using std::log;
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

    static constexpr float SimplePositiveInfinity = std::numeric_limits<float>::infinity();
    static constexpr float SimpleNegativeInfinity = -std::numeric_limits<float>::infinity();
    static constexpr float SimplePositiveInfinityf = std::numeric_limits<float>::infinity();
    static constexpr double DoublePositiveInfinity = std::numeric_limits<double>::infinity();
}

namespace streflop {
    // No-op FPU mode initialisation (streflop removed)
    struct Simple {};
    struct Double {};

    template<typename T>
    inline void streflop_init() {}
}

#endif // STREFLOP_COND_H
