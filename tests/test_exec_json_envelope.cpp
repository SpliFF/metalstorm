/**
 * /api/exec JSON-in-JSON envelope composition — PLAN-test-automation P6.
 *
 * The `json ` prefix on a `scope:"server"` exec verb makes the verb answer a
 * serialized JSON object, and that object then travels as a STRING inside the
 * /api/exec response, which GameHttpRoutes.cpp builds by concatenation:
 *
 *     "{\"success\":..,\"output\":\"" + HttpAuth::JsonEscape(out) + "\"}"
 *
 * So every inner quote gets escaped once by nlohmann (if it was in the data)
 * and once more by JsonEscape (because it is now envelope content). The
 * property the MCP depends on — escape(dump(x)) embeds losslessly, i.e. a
 * caller that parses the envelope and then parses `output` gets `x` back — is
 * what the tests below pin. It is asserted here rather than against a live
 * server because HttpAuth.h is header-only and needs no engine at all.
 */
#include <doctest/doctest.h>

#include "Server/HttpAuth.h"

#include <nlohmann/json.hpp>
#include <string>

namespace {

// The exact envelope shape from GameHttpRoutes.cpp's /api/exec handler.
std::string Envelope(bool success, const std::string& output) {
    return std::string("{\"success\":") + (success ? "true" : "false")
         + ",\"output\":\"" + HttpAuth::JsonEscape(output) + "\"}";
}

} // namespace

TEST_CASE("exec envelope carries a serialized JSON verb reply losslessly") {
    const nlohmann::json inner = {
        {"id", 31},
        {"def", "ms_tank"},
        {"team", 0},
        {"pos", {{"x", 512.5}, {"y", 88.0}, {"z", 1024.25}}},
    };

    const std::string body = Envelope(true, inner.dump());

    const nlohmann::json outer = nlohmann::json::parse(body);
    CHECK(outer["success"] == true);

    const nlohmann::json round = nlohmann::json::parse(outer["output"].get<std::string>());
    CHECK(round == inner);
}

TEST_CASE("a quote inside verb DATA survives both escaping layers") {
    // nlohmann escapes the quote into \" while dumping; JsonEscape then
    // escapes that backslash and quote again for the envelope. Double
    // escaping is correct only if both layers unwind — assert the unwind.
    const nlohmann::json inner = {{"def", "a\"b\\c"}};

    const nlohmann::json outer = nlohmann::json::parse(Envelope(true, inner.dump()));
    const nlohmann::json round = nlohmann::json::parse(outer["output"].get<std::string>());

    CHECK(round["def"].get<std::string>() == "a\"b\\c");
}

TEST_CASE("a legacy error string containing a quote keeps the envelope parseable") {
    // The failure mode the `json spawn bad"name ...` probe exercises: the verb
    // routes through LuaRules, the quote breaks the generated snippet, and the
    // reply is free text with a quote in it — NOT JSON. The envelope must
    // still parse (so the MCP can read `success`/`output` and report the
    // error) even though `output` will not.
    const std::string luaErr = "syntax error: unfinished string near '\"name'";

    const nlohmann::json outer = nlohmann::json::parse(Envelope(true, luaErr));
    CHECK(outer["output"].get<std::string>() == luaErr);
    CHECK_THROWS([&] {
        const nlohmann::json reparsed = nlohmann::json::parse(outer["output"].get<std::string>());
        (void)reparsed;
    }());
}

TEST_CASE("the capability probe string is what an old binary answers") {
    // An old binary never strips the prefix, so the unknown-command fallthrough
    // echoes it verbatim; ExecuteLuaExecRequest derives success from the
    // leading "unknown command:". The MCP keys its fallback off exactly this.
    const std::string oldReply = "unknown command: json frame";
    CHECK(oldReply.rfind("unknown command:", 0) == 0);

    const nlohmann::json outer = nlohmann::json::parse(Envelope(false, oldReply));
    CHECK(outer["success"] == false);
    CHECK(outer["output"].get<std::string>().rfind("unknown command: json", 0) == 0);
}
