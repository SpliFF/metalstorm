#include <doctest/doctest.h>
#include "System/FileSystem/DetailTexDc.h"

// PLAN-maps.md M8i. `textureconverter`'s mip chain truncated its 2x2 box
// average (`(a+b+c+d)/4`), which loses up to 0.75 of a level per step and
// compounds down the chain. For an ordinary texture that is a slight,
// distance-growing darkening nobody would ever notice; for a *detail* texture
// it is not, because SMFFragProg adds the sample signed (`tex*2-1`) with no
// fade uniform, so the top mip's mean is a constant tint applied at every
// viewing distance. Measured on the shipped content: green_flat's detailTex
// authored at mean 128.09 reached the 1x1 at 125.0 (-3.06 levels), and M8h
// had already read exactly that off the shipped file with `ktx extract`
// (signed DC -0.0196) and attributed it to the content.
//
// These cases pin the two things that fix are made of: a filter that does not
// move the DC, and a tolerance that separates "authored as close to neutral as
// 8-bit allows" from "actually off".

TEST_SUITE("detail texture DC") {
    TEST_CASE("mid-grey is 127.5, and 128 is not neutral") {
        CHECK(detailtex::SignedDcFromMean(detailtex::kNeutralMean)
              == doctest::Approx(0.0));
        // A flat 128 texture — the closest a *constant* 8-bit image can get —
        // still brightens the whole map by more than a level.
        CHECK(detailtex::DcInLevels(detailtex::SignedDcFromMean(128.0))
              == doctest::Approx(1.0));
        CHECK(detailtex::DcInLevels(detailtex::SignedDcFromMean(127.0))
              == doctest::Approx(-1.0));
    }

    TEST_CASE("the tolerance passes near-neutral content and fails the real defect") {
        // green_flat_x34_v3 / scorched_crossing / wanderlust2.1: authored at
        // 128, i.e. as neutral as a constant can be. Not worth a warning.
        CHECK(detailtex::IsDcNeutral(128.0943));
        CHECK(detailtex::IsDcNeutral(127.9928));
        CHECK(detailtex::IsDcNeutral(128.2112));
        // meridian_basin / skerry_reach splat detail, authored at 127.
        CHECK(detailtex::IsDcNeutral(127.0010));
        // techno_lands_final_2.60_wide: mean 126.07, a permanent -2.86-level
        // darkening. This is the one M8h found by rendering the map.
        CHECK_FALSE(detailtex::IsDcNeutral(126.0679));
        // Boundaries of the +/-2-level window.
        CHECK(detailtex::IsDcNeutral(128.5));
        CHECK(detailtex::IsDcNeutral(126.5));
        CHECK_FALSE(detailtex::IsDcNeutral(128.51));
        CHECK_FALSE(detailtex::IsDcNeutral(126.49));
    }

    TEST_CASE("the box filter rounds instead of truncating") {
        // The regression itself: truncation returns 127 here, losing 0.75.
        CHECK(detailtex::MipBoxAvg4(128, 128, 127, 128) == 128);
        CHECK(detailtex::MipBoxAvg4(127, 127, 127, 128) == 127);
        CHECK(detailtex::MipBoxAvg4(0, 0, 0, 3) == 1);
        // Exact values are unchanged.
        CHECK(detailtex::MipBoxAvg4(128, 128, 128, 128) == 128);
        CHECK(detailtex::MipBoxAvg4(0, 0, 0, 0) == 0);
        CHECK(detailtex::MipBoxAvg4(255, 255, 255, 255) == 255);
    }

    TEST_CASE("ties break to even, so a repeated chain does not drift") {
        // 127.5 is representable as a 2x2 average but not as a texel. Ties-up
        // would send every one of them the same way; over a nine-level chain
        // that measured +0.9 levels on real content.
        CHECK(detailtex::MipBoxAvg4(127, 127, 128, 128) == 128); // 127.5 -> 128
        CHECK(detailtex::MipBoxAvg4(128, 128, 129, 129) == 128); // 128.5 -> 128
        CHECK(detailtex::MipBoxAvg4(0, 0, 1, 1) == 0);           // 0.5 -> 0
        CHECK(detailtex::MipBoxAvg4(1, 1, 2, 2) == 2);           // 1.5 -> 2
    }

    TEST_CASE("a full chain over a neutral source holds its DC") {
        // 8x8 of alternating 127/128 — mean exactly 127.5, the neutral target
        // an 8-bit texture can only hit on average. Reduce it the way
        // EncodeRgba8AsKtx2 does and check the DC never walks off.
        int level[8][8];
        for (int y = 0; y < 8; ++y)
            for (int x = 0; x < 8; ++x)
                level[y][x] = ((x + y) & 1) ? 128 : 127;

        int w = 8;
        while (w > 1) {
            const int nw = w / 2;
            int next[8][8];
            for (int y = 0; y < nw; ++y)
                for (int x = 0; x < nw; ++x)
                    next[y][x] = detailtex::MipBoxAvg4(
                        level[y * 2][x * 2], level[y * 2][x * 2 + 1],
                        level[y * 2 + 1][x * 2], level[y * 2 + 1][x * 2 + 1]);
            for (int y = 0; y < nw; ++y)
                for (int x = 0; x < nw; ++x) level[y][x] = next[y][x];
            w = nw;

            double sum = 0;
            for (int y = 0; y < w; ++y)
                for (int x = 0; x < w; ++x) sum += level[y][x];
            const double mean = sum / (w * w);
            // Never more than the single-texel quantisation away from neutral.
            CHECK(std::abs(mean - detailtex::kNeutralMean) <= 0.5);
            CHECK(detailtex::IsDcNeutral(mean));
        }
    }
}
