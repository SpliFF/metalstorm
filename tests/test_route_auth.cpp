#include <doctest/doctest.h>

#include "Server/NetworkServer.h"

// PLAN-security-hardening task 6 (G20): AddHttpGet/AddHttpPost now require a
// RouteAuth tag as a mandatory argument — a route literally cannot be
// registered without a conscious classification. This is a unit test of that
// mechanism (registration + GetRegisteredRoutes() introspection), not a
// live-socket test of a running server: NetworkServer's route registration
// (AddHttpGet/AddHttpPost/GetRegisteredRoutes) needs no bind()/Start(), so
// this stays a fast, deterministic unit test consistent with the rest of
// this suite. A true "does the real app's route inventory match
// PLAN-security-hardening.md §1.1" snapshot would need either extracting
// lobby_main.cpp's inline route registration into a standalone, dependency-
// light function (it currently isn't — everything lives in main()) or a
// live-process integration test; both are bigger asks than this pass — see
// the task 6 field notes in PLAN-security-hardening.md.

TEST_CASE("NetworkServer.GetRegisteredRoutes reports every registered route with its RouteAuth tag") {
    NetworkServer net;
    net.AddHttpGet("/api/public", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        return {.status = 200};
    });
    net.AddHttpPost("/api/rooms/join", RouteAuth::TokenRequired,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });
    net.AddHttpPost("/api/exec", RouteAuth::AdminOnly,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });
    net.AddHttpPost("/api/rooms/direct", RouteAuth::LocalhostOrAdmin,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });

    auto routes = net.GetRegisteredRoutes();
    REQUIRE(routes.size() == 4);

    auto find = [&](const std::string& method, const std::string& pattern) -> const RouteInfo* {
        for (auto& r : routes)
            if (r.method == method && r.pattern == pattern) return &r;
        return nullptr;
    };

    auto* pub = find("GET", "/api/public");
    REQUIRE(pub != nullptr);
    CHECK(pub->auth == RouteAuth::Public);

    auto* join = find("POST", "/api/rooms/join");
    REQUIRE(join != nullptr);
    CHECK(join->auth == RouteAuth::TokenRequired);

    auto* exec = find("POST", "/api/exec");
    REQUIRE(exec != nullptr);
    CHECK(exec->auth == RouteAuth::AdminOnly);

    auto* direct = find("POST", "/api/rooms/direct");
    REQUIRE(direct != nullptr);
    CHECK(direct->auth == RouteAuth::LocalhostOrAdmin);
}

TEST_CASE("NetworkServer.GetRegisteredRoutes distinguishes GET and POST on the same pattern") {
    NetworkServer net;
    net.AddHttpGet("/api/maps", RouteAuth::Public, [](const std::string&) -> HttpResponse {
        return {.status = 200};
    });
    net.AddHttpPost("/api/maps", RouteAuth::AdminOnly,
        [](const std::string&, const std::string&, const HttpRequestHeaders&) -> HttpResponse {
            return {.status = 200};
        });

    auto routes = net.GetRegisteredRoutes();
    REQUIRE(routes.size() == 2);

    int getCount = 0, postCount = 0;
    for (auto& r : routes) {
        CHECK(r.pattern == "/api/maps");
        if (r.method == "GET") { CHECK(r.auth == RouteAuth::Public); getCount++; }
        if (r.method == "POST") { CHECK(r.auth == RouteAuth::AdminOnly); postCount++; }
    }
    CHECK(getCount == 1);
    CHECK(postCount == 1);
}
