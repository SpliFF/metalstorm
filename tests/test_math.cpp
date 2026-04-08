#include <doctest/doctest.h>
#include "System/float3.h"
#include "System/float4.h"
#include "System/Matrix44f.h"
#include <cmath>

TEST_SUITE("float3") {
    TEST_CASE("default constructor is zero") {
        float3 v;
        CHECK(v.x == 0.0f);
        CHECK(v.y == 0.0f);
        CHECK(v.z == 0.0f);
    }

    TEST_CASE("parameterized constructor") {
        float3 v(1.0f, 2.0f, 3.0f);
        CHECK(v.x == 1.0f);
        CHECK(v.y == 2.0f);
        CHECK(v.z == 3.0f);
    }

    TEST_CASE("addition") {
        float3 a(1.0f, 2.0f, 3.0f);
        float3 b(4.0f, 5.0f, 6.0f);
        float3 c = a + b;
        CHECK(c.x == doctest::Approx(5.0f));
        CHECK(c.y == doctest::Approx(7.0f));
        CHECK(c.z == doctest::Approx(9.0f));
    }

    TEST_CASE("subtraction") {
        float3 a(4.0f, 5.0f, 6.0f);
        float3 b(1.0f, 2.0f, 3.0f);
        float3 c = a - b;
        CHECK(c.x == doctest::Approx(3.0f));
        CHECK(c.y == doctest::Approx(3.0f));
        CHECK(c.z == doctest::Approx(3.0f));
    }

    TEST_CASE("scalar multiply") {
        float3 v(1.0f, 2.0f, 3.0f);
        float3 r = v * 2.0f;
        CHECK(r.x == doctest::Approx(2.0f));
        CHECK(r.y == doctest::Approx(4.0f));
        CHECK(r.z == doctest::Approx(6.0f));
    }

    TEST_CASE("negation") {
        float3 v(1.0f, -2.0f, 3.0f);
        float3 n = -v;
        CHECK(n.x == doctest::Approx(-1.0f));
        CHECK(n.y == doctest::Approx(2.0f));
        CHECK(n.z == doctest::Approx(-3.0f));
    }

    TEST_CASE("dot product") {
        float3 a(1.0f, 0.0f, 0.0f);
        float3 b(0.0f, 1.0f, 0.0f);
        CHECK(a.dot(b) == doctest::Approx(0.0f));

        float3 c(1.0f, 2.0f, 3.0f);
        float3 d(4.0f, 5.0f, 6.0f);
        CHECK(c.dot(d) == doctest::Approx(32.0f));
    }

    TEST_CASE("cross product") {
        float3 x(1.0f, 0.0f, 0.0f);
        float3 y(0.0f, 1.0f, 0.0f);
        float3 z = x.cross(y);
        CHECK(z.x == doctest::Approx(0.0f));
        CHECK(z.y == doctest::Approx(0.0f));
        CHECK(z.z == doctest::Approx(1.0f));
    }

    TEST_CASE("length") {
        float3 v(3.0f, 4.0f, 0.0f);
        CHECK(v.Length() == doctest::Approx(5.0f));
        CHECK(v.SqLength() == doctest::Approx(25.0f));
    }

    TEST_CASE("length 2D") {
        float3 v(3.0f, 100.0f, 4.0f);
        CHECK(v.Length2D() == doctest::Approx(5.0f));
        CHECK(v.SqLength2D() == doctest::Approx(25.0f));
    }

    TEST_CASE("distance") {
        float3 a(0.0f, 0.0f, 0.0f);
        float3 b(3.0f, 4.0f, 0.0f);
        CHECK(a.distance(b) == doctest::Approx(5.0f));
        CHECK(a.SqDistance(b) == doctest::Approx(25.0f));
    }

    TEST_CASE("normalize") {
        float3 v(3.0f, 0.0f, 4.0f);
        float3 n = v;
        n.Normalize();
        CHECK(n.Length() == doctest::Approx(1.0f));
        CHECK(n.x == doctest::Approx(0.6f));
        CHECK(n.z == doctest::Approx(0.8f));
    }

    TEST_CASE("array access") {
        float3 v(10.0f, 20.0f, 30.0f);
        CHECK(v[0] == 10.0f);
        CHECK(v[1] == 20.0f);
        CHECK(v[2] == 30.0f);
    }

    TEST_CASE("equality uses epsilon") {
        float3 a(1.0f, 2.0f, 3.0f);
        float3 b(1.0f, 2.0f, 3.0f);
        CHECK(a == b);

        float3 c(1.0f, 2.0f, 100.0f);
        CHECK(a != c);
    }
}

TEST_SUITE("float4") {
    TEST_CASE("default constructor") {
        float4 v;
        CHECK(v.x == 0.0f);
        CHECK(v.y == 0.0f);
        CHECK(v.z == 0.0f);
        CHECK(v.w == 0.0f);
    }

    TEST_CASE("construct from float3 + w") {
        float3 base(1.0f, 2.0f, 3.0f);
        float4 v(base, 4.0f);
        CHECK(v.x == 1.0f);
        CHECK(v.y == 2.0f);
        CHECK(v.z == 3.0f);
        CHECK(v.w == 4.0f);
    }

    TEST_CASE("arithmetic") {
        float4 a(1.0f, 2.0f, 3.0f, 4.0f);
        float4 b(5.0f, 6.0f, 7.0f, 8.0f);

        float4 sum = a + b;
        CHECK(sum.x == doctest::Approx(6.0f));
        CHECK(sum.w == doctest::Approx(12.0f));

        float4 diff = b - a;
        CHECK(diff.x == doctest::Approx(4.0f));
        CHECK(diff.w == doctest::Approx(4.0f));

        float4 scaled = a * 2.0f;
        CHECK(scaled.x == doctest::Approx(2.0f));
        CHECK(scaled.w == doctest::Approx(8.0f));
    }

    TEST_CASE("inherits float3 methods") {
        float4 v(3.0f, 4.0f, 0.0f, 1.0f);
        // Length comes from float3 (only x,y,z)
        CHECK(v.Length() == doctest::Approx(5.0f));
    }
}

TEST_SUITE("CMatrix44f") {
    TEST_CASE("default is identity") {
        CMatrix44f m;
        CHECK(m.IsIdentity());

        // Diagonal should be 1
        CHECK(m[0] == 1.0f);
        CHECK(m[5] == 1.0f);
        CHECK(m[10] == 1.0f);
        CHECK(m[15] == 1.0f);

        // Off-diagonal should be 0
        CHECK(m[1] == 0.0f);
        CHECK(m[4] == 0.0f);
    }

    TEST_CASE("translation") {
        CMatrix44f m;
        m.Translate(10.0f, 20.0f, 30.0f);

        float3 pos = m.GetPos();
        CHECK(pos.x == doctest::Approx(10.0f));
        CHECK(pos.y == doctest::Approx(20.0f));
        CHECK(pos.z == doctest::Approx(30.0f));
    }

    TEST_CASE("identity * vector = vector") {
        CMatrix44f m;
        float3 v(1.0f, 2.0f, 3.0f);
        float3 r = m * v;
        CHECK(r.x == doctest::Approx(1.0f));
        CHECK(r.y == doctest::Approx(2.0f));
        CHECK(r.z == doctest::Approx(3.0f));
    }

    TEST_CASE("translation * point adds offset") {
        CMatrix44f m;
        m.Translate(10.0f, 0.0f, 0.0f);
        float3 v(1.0f, 2.0f, 3.0f);
        float3 r = m * v;
        CHECK(r.x == doctest::Approx(11.0f));
        CHECK(r.y == doctest::Approx(2.0f));
        CHECK(r.z == doctest::Approx(3.0f));
    }

    TEST_CASE("SetPos / GetPos roundtrip") {
        CMatrix44f m;
        float3 p(5.0f, 10.0f, 15.0f);
        m.SetPos(p);
        float3 r = m.GetPos();
        CHECK(r.x == doctest::Approx(5.0f));
        CHECK(r.y == doctest::Approx(10.0f));
        CHECK(r.z == doctest::Approx(15.0f));
    }

    TEST_CASE("matrix multiply identity") {
        CMatrix44f a;
        a.Translate(1.0f, 2.0f, 3.0f);
        CMatrix44f identity;
        CMatrix44f result = a * identity;

        float3 pos = result.GetPos();
        CHECK(pos.x == doctest::Approx(1.0f));
        CHECK(pos.y == doctest::Approx(2.0f));
        CHECK(pos.z == doctest::Approx(3.0f));
    }

    TEST_CASE("scale") {
        CMatrix44f m;
        m.Scale(float3(2.0f, 3.0f, 4.0f));
        float3 v(1.0f, 1.0f, 1.0f);
        float3 r = m * v;
        CHECK(r.x == doctest::Approx(2.0f));
        CHECK(r.y == doctest::Approx(3.0f));
        CHECK(r.z == doctest::Approx(4.0f));
    }

    TEST_CASE("invert identity") {
        CMatrix44f m;
        bool ok = false;
        CMatrix44f inv = m.Invert(&ok);
        CHECK(ok);
        CHECK(inv.IsIdentity());
    }
}
