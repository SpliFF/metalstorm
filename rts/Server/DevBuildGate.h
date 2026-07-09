/**
 * DevBuildGate — PLAN-security-hardening §4 edge case E1.
 *
 * Non-SPRING_PROD binaries carry the full exec/SQL-proxy/debug/test surface
 * and always bind every interface (NetworkServer has no localhost-only bind
 * mode). Self-hosted/open-source deployments running a dev build in public
 * is the realistic accident this guards against — not DRM, just an
 * unmissable warning plus an explicit, deliberate opt-in before the process
 * will bind at all.
 */
#pragma once

#include <cstdio>

namespace DevBuildGate {

inline void PrintBanner(const char* processName) {
#ifndef SPRING_PROD
    fprintf(stderr, "\n");
    fprintf(stderr, "############################################################\n");
    fprintf(stderr, "##  WARNING: %-46s ##\n", processName);
    fprintf(stderr, "##  This is a DEV BUILD (SPRING_PROD is not set).         ##\n");
    fprintf(stderr, "##  Exec route, SQL proxy, debug/test verbs, and dev-mode ##\n");
    fprintf(stderr, "##  account auto-registration are ALL ENABLED.            ##\n");
    fprintf(stderr, "##  Do NOT expose this process to the public internet.    ##\n");
    fprintf(stderr, "##  Build with -DSPRING_PROD=ON for a production binary.  ##\n");
    fprintf(stderr, "############################################################\n");
    fprintf(stderr, "\n");
#else
    (void)processName;
#endif
}

/// Call once at startup, before NetworkServer::Start(). Returns false (and
/// has already printed a FATAL line) if the caller should abort — dev builds
/// with no --i-understand-this-is-a-dev-build. SPRING_PROD builds always
/// return true (this whole gate compiles to a no-op). Used by spring-lobby
/// and spring-logserver, whose launch surface (mprocs.yaml + the lobby's own
/// spawnGameServer fork/exec) is fully known and updated alongside this gate.
inline bool CheckAndWarn(const char* processName, bool acknowledged) {
    PrintBanner(processName);
#ifndef SPRING_PROD
    if (!acknowledged) {
        fprintf(stderr,
            "FATAL: refusing to start — pass --i-understand-this-is-a-dev-build\n"
            "       to confirm this process will not be reachable from the\n"
            "       public internet (documentation, not DRM: it's open source).\n\n");
        return false;
    }
#else
    (void)acknowledged;
#endif
    return true;
}

/// Banner-only variant for spring-server: it has too many direct-launch call
/// sites (spring-test MCP tooling, manual `./spring-server ...` dev
/// invocation, the spring-debug `launch_game` verb) to safely audit and
/// update with a hard-refuse gate in one pass without risking the core
/// testing workflow. Deliberate, called-out scope cut — see
/// PLAN-security-hardening.md task 2 field notes. The normal spawn path
/// (spring-lobby → spawnGameServer) already propagates
/// --i-understand-this-is-a-dev-build when the lobby itself was acknowledged.
inline void WarnOnly(const char* processName) {
    PrintBanner(processName);
}

/// CLI flag every dev-build entry point parses the same way.
inline constexpr const char* kFlag = "--i-understand-this-is-a-dev-build";

} // namespace DevBuildGate
