#include <doctest/doctest.h>
#include "System/FileSystem/Ktx2Orientation.h"

// PLAN-maps.md M8f. Every KTX2 this project shipped was invalid per spec
// for months because `textureconverter` stamped `KTXorientation` using
// libktx's KTX**1** `KTX_ORIENTATION2_FMT` spelling (`S=r,T=d`). Babylon
// and basisu ignore the key so nothing rendered wrong, and the only
// symptom was that the Khronos `ktx` CLI refused to open our own assets —
// a failure mode no render test can see. These cases pin the spelling to
// the KTX2 §3.11.4 grammar so the regression cannot come back silently.

TEST_SUITE("KTX2 orientation") {
    TEST_CASE("the stamped 2D value is spec-legal") {
        CHECK(ktx2::IsValidOrientation(ktx2::kOrientation2D, 2));
        // Row order is top-down (glTF 2.0 convention), not bottom-up:
        // flipping it would mirror every texture we ship.
        CHECK(std::string_view(ktx2::kOrientation2D) == "rd");
    }

    TEST_CASE("the KTX1 spelling is rejected") {
        // The exact regression: `ktx validate` reports error-7108 (7
        // dimensions declared for a 2D texture) and error-7109 (letter
        // grammar) on this value.
        CHECK_FALSE(ktx2::IsValidOrientation("S=r,T=d", 2));
    }

    TEST_CASE("grammar accepts every legal per-dimension letter") {
        CHECK(ktx2::IsValidOrientation("r", 1));
        CHECK(ktx2::IsValidOrientation("l", 1));
        CHECK(ktx2::IsValidOrientation("ru", 2));
        CHECK(ktx2::IsValidOrientation("ld", 2));
        CHECK(ktx2::IsValidOrientation("rdo", 3));
        CHECK(ktx2::IsValidOrientation("lui", 3));
    }

    TEST_CASE("grammar rejects wrong letters, lengths and dimensions") {
        CHECK_FALSE(ktx2::IsValidOrientation("xd", 2));   // bad S letter
        CHECK_FALSE(ktx2::IsValidOrientation("rx", 2));   // bad T letter
        CHECK_FALSE(ktx2::IsValidOrientation("rdx", 3));  // bad R letter
        CHECK_FALSE(ktx2::IsValidOrientation("rd", 1));   // too long for 1D
        CHECK_FALSE(ktx2::IsValidOrientation("r", 2));    // too short for 2D
        CHECK_FALSE(ktx2::IsValidOrientation("", 2));
        CHECK_FALSE(ktx2::IsValidOrientation("rd", 0));
        CHECK_FALSE(ktx2::IsValidOrientation("rdoi", 4));
    }
}
