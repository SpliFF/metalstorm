#include <doctest/doctest.h>

#include "Server/NetworkServer.h"

#include <nlohmann/json.hpp>
#include <stdexcept>

// Un-owned lobby crash (DECISIONS.md Part 6): a room-abandon session hit an
// uncaught nlohmann::json::type_error (a std::exception) inside a POST route
// handler, which took down the whole spring-lobby process — every other
// player's connection with it. NetworkServer::SafeInvokeForTest exercises the
// exact wrapper DispatchGet/DispatchPost/CheckAuthAndCall now run every
// handler through, without needing a live socket.

TEST_CASE("NetworkServer.SafeInvokeForTest converts a thrown nlohmann::json::type_error into a 500") {
    auto resp = NetworkServer::SafeInvokeForTest("/api/rooms/leave", []() -> HttpResponse {
        nlohmann::json j = nlohmann::json::object();
        // Same failure mode as the crash: a field expected to be a string is
        // actually an object, so .get<std::string>() throws type_error.302.
        j["password"] = nlohmann::json::object();
        std::string password = j["password"].get<std::string>();
        return {.status = 200, .body = {password.begin(), password.end()}};
    });
    CHECK(resp.status == 500);
    CHECK(resp.contentType == "application/json");
    std::string body(resp.body.begin(), resp.body.end());
    CHECK(body.find("error") != std::string::npos);
}

TEST_CASE("NetworkServer.SafeInvokeForTest converts an arbitrary std::exception into a 500") {
    auto resp = NetworkServer::SafeInvokeForTest("/api/boom", []() -> HttpResponse {
        throw std::runtime_error("boom");
    });
    CHECK(resp.status == 500);
}

TEST_CASE("NetworkServer.SafeInvokeForTest passes through a handler's normal response unchanged") {
    auto resp = NetworkServer::SafeInvokeForTest("/api/ok", []() -> HttpResponse {
        return {.contentType = "application/json", .body = {'{', '}'}, .status = 200};
    });
    CHECK(resp.status == 200);
    CHECK(resp.contentType == "application/json");
    REQUIRE(resp.body.size() == 2);
}
