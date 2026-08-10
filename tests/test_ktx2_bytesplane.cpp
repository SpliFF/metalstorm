#include <doctest/doctest.h>
#include "System/FileSystem/Ktx2BytesPlane.h"

// PLAN-maps.md M8f/M9i. Every Zstd-supercompressed KTX2 this project
// wrote carried `bytesPlane0 = 0` in its basic DFD block, which spec
// 2.0.4 forbids — libktx 4.3.2 zeroes the word at the end of
// `ktxTexture2_DeflateZstd` because it still implements the 2.0.3 rule.
// `ktx validate` reports it as warning-6030 and exits 0, so no gate in
// the pipeline could see it; the only symptom was the Khronos validator
// complaining about our own assets. These cases pin the two DFD word
// offsets and the spec predicate so the save/restore in
// `textureconverter` cannot silently reach for the wrong word.

TEST_SUITE("KTX2 bytesPlane") {
    TEST_CASE("the word offsets match Khronos' khr_df.h") {
        // KHR_DF_WORD_BYTESPLANE0 == 4, KHR_DF_WORD_BYTESPLANE4 == 5,
        // indexed against the *basic* block — i.e. libktx's `pDfd + 1`,
        // since pDfd[0] is the descriptor's total size.
        CHECK(ktx2::kBdfdWordBytesPlane0 == 4);
        CHECK(ktx2::kBdfdWordBytesPlane4 == 5);
        // They are adjacent and distinct: restoring one without the
        // other leaves half the field cleared.
        CHECK(ktx2::kBdfdWordBytesPlane4 == ktx2::kBdfdWordBytesPlane0 + 1);
    }

    TEST_CASE("bytesPlane0 is the low byte of its word") {
        // UASTC (the encoder default): 4x4x1 blocks of 16 bytes.
        CHECK(ktx2::BytesPlane0Of(0x00000010u) == 16);
        // Raw-DXT1 wrap (BC1) and ETC1S: 8-byte blocks.
        CHECK(ktx2::BytesPlane0Of(0x00000008u) == 8);
        // RGBA8 fallback: 4 bytes per texel.
        CHECK(ktx2::BytesPlane0Of(0x00000004u) == 4);
        // bytesPlane1..3 live in the upper bytes and must not leak into
        // the answer — they are non-zero only for planar formats we do
        // not write, but a mask bug here would read one of them as the
        // size and pass the spec check for the wrong reason.
        CHECK(ktx2::BytesPlane0Of(0x02030400u) == 0);
        CHECK(ktx2::BytesPlane0Of(0xFFFFFF10u) == 16);
    }

    TEST_CASE("the spec 2.0.4 predicate rejects exactly the defect") {
        // This is the file we shipped for months.
        CHECK_FALSE(ktx2::IsSizedForSupercompression(0x00000000u));
        // ...and this is what libktx 4.4 / toktx v4.4.2 write instead.
        CHECK(ktx2::IsSizedForSupercompression(0x00000010u));
        // Sized in a higher plane only is still the defect: the
        // validator names bytesPlane0 specifically.
        CHECK_FALSE(ktx2::IsSizedForSupercompression(0x00001000u));
    }
}
