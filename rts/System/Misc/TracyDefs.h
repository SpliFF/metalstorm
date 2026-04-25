#pragma once

// Tracy profiler not available in headless server build.
// Stub all Tracy macros to no-ops.

#define RECOIL_DETAILED_TRACY_ZONE do {} while(0)

#define ZoneScoped do {} while(0)
#define ZoneScopedN(x) do {} while(0)
#define ZoneScopedNC(x, c) do {} while(0)
#define TracyPlot(x, y) do {} while(0)
#define FrameMark do {} while(0)

namespace tracy {
    enum Color : unsigned int {
        Goldenrod = 0xDAA520,
        Red = 0xFF0000,
        Green = 0x00FF00,
        Blue = 0x0000FF,
    };
}
