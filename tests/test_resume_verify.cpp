#include <doctest/doctest.h>

#include "Server/ResumeVerify.h"

#include <string>
#include <vector>

// PLAN-persistence §8 — the fresh-process re-capture bar behind
// `--resume-verify` (ResumeVerify.h). The comparison is pure; what these
// cases defend is the VERDICT's honesty:
//
//  * "identical" must mean byte-identical, never "same length" or "same
//    sections" — the three restore defects this bar has caught all differed
//    in a handful of bytes inside otherwise-identical payloads;
//  * a difference must be located (section + byte), because "byte 51 234" is
//    unactionable and an empty sections list must never read as "no sections
//    disagree";
//  * the two sentinel phrases are load-bearing: the live harness
//    (tools/scripts/hibernate-resume-recapture.sh) gates on them because a
//    debug build's exit code is a lie (PLAN-replay T5-c's exit-time abort).

using resumeverify::Compare;
using resumeverify::Format;
using resumeverify::Verdict;

namespace {

// A payload in the on-the-wire shape SimSnapshot frames: u16 version,
// u32 section count, then per section u16 id, u16 version, u32 length, body.
// Same helper shape as test_sim_snapshot.cpp's — duplicated because both are
// test-local statics and the framing constants are pinned by that suite.
std::vector<uint8_t> framePayload(
    const std::vector<std::pair<uint16_t, std::vector<uint8_t>>>& sections)
{
    std::vector<uint8_t> out;
    auto u16 = [&out](uint16_t v) { out.push_back(uint8_t(v)); out.push_back(uint8_t(v >> 8)); };
    auto u32 = [&out](uint32_t v) {
        for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i)));
    };
    u16(1);
    u32(static_cast<uint32_t>(sections.size()));
    for (const auto& [id, body] : sections) {
        u16(id);
        u16(1);
        u32(static_cast<uint32_t>(body.size()));
        out.insert(out.end(), body.begin(), body.end());
    }
    return out;
}

}  // namespace

TEST_CASE("resume verify: identical payloads are IDENTICAL, with no location") {
    const auto p = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {6, std::vector<uint8_t>(10, 3)}});
    const Verdict v = Compare(p, p);
    CHECK(v.identical);
    CHECK(v.appliedBytes == p.size());
    CHECK(v.recapturedBytes == p.size());
    CHECK(v.firstDifferentByte == -1);
    CHECK(v.where.empty());
    CHECK(v.sections.empty());

    const std::string line = Format(v, 302);
    CHECK(line.find("resume verify: recapture IDENTICAL") != std::string::npos);
    CHECK(line.find("302") != std::string::npos);
    CHECK(line.find(std::to_string(p.size())) != std::string::npos);
    // The failing sentinel must not appear in a passing line — the harness
    // greps for both, and a line carrying both would gate as whichever grep
    // runs first.
    CHECK(line.find("DIFFERS") == std::string::npos);
}

TEST_CASE("resume verify: one flipped byte is located by section and offset") {
    // globals (id 1, 21 bytes) then units (id 6, 10 bytes).
    const auto a = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {6, std::vector<uint8_t>(10, 3)}});
    auto b = a;
    // Byte 4 of the globals body: header is 6 bytes, section header 8.
    const size_t off = 6 + 8 + 4;
    b[off] ^= 0xFF;

    const Verdict v = Compare(a, b);
    CHECK_FALSE(v.identical);
    CHECK(v.firstDifferentByte == int64_t(off));
    // The phrase names the section, not just the byte — the Q-P4 lesson:
    // "globals byte 4" is the RNG position, and that identification is what
    // turned a mystery into a one-run diagnosis.
    CHECK(v.where.find("globals") != std::string::npos);
    REQUIRE(v.sections.size() == 1);
    CHECK(v.sections[0] == "globals");

    const std::string line = Format(v, 621);
    CHECK(line.find("resume verify: recapture DIFFERS") != std::string::npos);
    CHECK(line.find("globals") != std::string::npos);
    CHECK(line.find(std::to_string(off)) != std::string::npos);
    CHECK(line.find("IDENTICAL") == std::string::npos);
}

TEST_CASE("resume verify: differences in two sections name both") {
    const auto a = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {5, std::vector<uint8_t>(30, 7)},
                                 {6, std::vector<uint8_t>(10, 3)}});
    auto b = a;
    b[6 + 8 + 2] ^= 1;                    // inside globals
    b[6 + 8 + 21 + 8 + 5] ^= 1;          // inside teams (id 5)
    const Verdict v = Compare(a, b);
    CHECK_FALSE(v.identical);
    REQUIRE(v.sections.size() == 2);
    CHECK(v.sections[0] == "globals");
    CHECK(v.sections[1] == "teams");
    // The first byte is in globals; the report must carry BOTH names — "only
    // globals" (an RNG drift) and "globals + teams" are different defects.
    const std::string line = Format(v, 1);
    CHECK(line.find("globals") != std::string::npos);
    CHECK(line.find("teams") != std::string::npos);
}

TEST_CASE("resume verify: a clean prefix is a difference, located at the cut") {
    // The re-capture missing a whole trailing section must not read as
    // identical: equality is over ALL bytes, and the first difference is
    // where the shorter side ends.
    const auto a = framePayload({{1, std::vector<uint8_t>(21, 0)},
                                 {6, std::vector<uint8_t>(10, 3)}});
    const auto b = framePayload({{1, std::vector<uint8_t>(21, 0)}});
    // b's section count differs at byte 2, so this is not literally a prefix
    // — build a true prefix instead: same bytes, truncated.
    std::vector<uint8_t> prefix(a.begin(), a.begin() + a.size() - 10);

    SUBCASE("recapture truncated") {
        const Verdict v = Compare(a, prefix);
        CHECK_FALSE(v.identical);
        CHECK(v.firstDifferentByte == int64_t(prefix.size()));
        CHECK(v.appliedBytes == a.size());
        CHECK(v.recapturedBytes == prefix.size());
    }
    SUBCASE("applied truncated") {
        const Verdict v = Compare(prefix, a);
        CHECK_FALSE(v.identical);
        CHECK(v.firstDifferentByte == int64_t(prefix.size()));
        // Described against the applied payload, whose end this is past —
        // the phrase must say so rather than fabricate a section name.
        CHECK(v.where.find("past the end") != std::string::npos);
    }
    SUBCASE("different section rosters are named, not just counted") {
        const Verdict v = Compare(a, b);
        CHECK_FALSE(v.identical);
        REQUIRE(v.sections.size() == 1);
        CHECK(v.sections[0].find("units") == 0);
        CHECK(v.sections[0].find("absent") != std::string::npos);
    }
}

TEST_CASE("resume verify: unparseable payloads still produce an honest line") {
    // Two garbage blobs that differ: DiffSections can name nothing, and the
    // formatted line must say the payload was unparseable rather than print
    // an empty list that reads as "no sections disagree".
    const std::vector<uint8_t> a(16, 0xAB);
    std::vector<uint8_t> b = a;
    b[9] = 0;
    const Verdict v = Compare(a, b);
    CHECK_FALSE(v.identical);
    CHECK(v.firstDifferentByte == 9);
    const std::string line = Format(v, 0);
    CHECK(line.find("resume verify: recapture DIFFERS") != std::string::npos);
    CHECK(line.find("unparseable") != std::string::npos);
}
