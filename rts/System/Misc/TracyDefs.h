#pragma once

// Tracy profiler not available in headless server build
#define RECOIL_DETAILED_TRACY_ZONE do {} while(0)

// Stub out Tracy macros used throughout Recoil code
#define ZoneScoped do {} while(0)
#define ZoneScopedN(x) do {} while(0)
#define TracyPlot(x, y) do {} while(0)
#define FrameMark do {} while(0)
