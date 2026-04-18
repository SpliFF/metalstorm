#ifndef _SIMD_COMPAT_H
#define _SIMD_COMPAT_H

#if defined(__aarch64__) || defined(_M_ARM64)
    // ARM64 — use sse2neon to translate SSE intrinsics
    #include "lib/sse2neon/sse2neon.h"
#elif defined(__x86_64__) || defined(_M_X64) || defined(__i386__) || defined(_M_IX86)
    #ifdef _MSC_VER
        #include <intrin.h>
    #else
        #include <x86intrin.h>
    #endif
    #include <immintrin.h>
    #include <xmmintrin.h>
    #include <emmintrin.h>
#endif

#endif // _SIMD_COMPAT_H
