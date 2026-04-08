#include <doctest/doctest.h>
#include "System/CRC.h"

TEST_SUITE("CRC") {
    TEST_CASE("empty CRC has consistent digest") {
        CRC a;
        CRC b;
        CHECK(a.GetDigest() == b.GetDigest());
    }

    TEST_CASE("same data produces same digest") {
        CRC a;
        CRC b;
        a.Update(uint32_t(12345));
        b.Update(uint32_t(12345));
        CHECK(a.GetDigest() == b.GetDigest());
    }

    TEST_CASE("different data produces different digest") {
        CRC a;
        CRC b;
        a.Update(uint32_t(12345));
        b.Update(uint32_t(54321));
        CHECK(a.GetDigest() != b.GetDigest());
    }

    TEST_CASE("stream operator") {
        CRC a;
        a << int32_t(42) << uint32_t(100);

        CRC b;
        b << int32_t(42) << uint32_t(100);

        CHECK(a.GetDigest() == b.GetDigest());
    }

    TEST_CASE("update with buffer") {
        const char data[] = "Hello, Spring!";
        CRC a;
        a.Update(data, sizeof(data));

        CRC b;
        b.Update(data, sizeof(data));

        CHECK(a.GetDigest() == b.GetDigest());
    }

    TEST_CASE("order matters") {
        CRC a;
        a << uint32_t(1) << uint32_t(2);

        CRC b;
        b << uint32_t(2) << uint32_t(1);

        CHECK(a.GetDigest() != b.GetDigest());
    }

    TEST_CASE("CalcDigest static method") {
        uint32_t data = 0xDEADBEEF;
        uint32_t d1 = CRC::CalcDigest(&data, sizeof(data));
        uint32_t d2 = CRC::CalcDigest(&data, sizeof(data));
        CHECK(d1 == d2);
        CHECK(d1 != 0);
    }
}
