/**
 * spring-server entry point
 *
 * Minimal headless server that will eventually run the full simulation
 * and serve game state over WebSocket. For now, this just verifies
 * that the core math/utility layer compiles and links.
 */

#include "System/float3.h"
#include "System/Matrix44f.h"
#include "System/SpringMath.h"

#include <cstdio>

int main(int argc, char* argv[])
{
    // Verify core math types work
    float3 a(1.0f, 2.0f, 3.0f);
    float3 b(4.0f, 5.0f, 6.0f);
    float3 c = a + b;

    std::printf("spring-server starting...\n");
    std::printf("Math test: (%g, %g, %g) + (%g, %g, %g) = (%g, %g, %g)\n",
        a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    std::printf("Distance: %g\n", a.distance(b));

    CMatrix44f mat;
    std::printf("Identity matrix diagonal: %g %g %g %g\n",
        mat[0], mat[5], mat[10], mat[15]);

    std::printf("spring-server: core math layer OK\n");
    return 0;
}
