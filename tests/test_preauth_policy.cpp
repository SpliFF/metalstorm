/**
 * Pre-auth surface — PLAN-protocol-guard task 6.
 *
 * The audit's finding, held in place: exactly three of the 45 ClientPayload
 * union members may be dispatched from a connection with no session. The
 * check that matters most is the completeness one — a verb added to
 * protocol.fbs and forgotten here is precisely the failure this file exists to
 * make impossible, and it is also the failure the old regime (one hand-written
 * session lookup per case) was one forgetful commit away from at all times.
 */
#include <doctest/doctest.h>

#include "Server/PreAuthPolicy.h"
#include "Server/SyncedInputJournal.h"

#include <set>
#include <string>

using preauth::IsOpenPreAuth;
using preauth::RequiresSession;

TEST_CASE("the pre-auth allow-list is exactly the three admission verbs") {
    std::set<std::string> open;
    for (const auto v : SpringWeb::EnumValuesClientPayload()) {
        if (IsOpenPreAuth(static_cast<uint8_t>(v)))
            open.insert(SpringWeb::EnumNameClientPayload(v));
    }
    CHECK(open == std::set<std::string>{"Handshake", "AuthRequest", "Ping"});
}

TEST_CASE("every union member is classified, including new ones") {
    // The tripwire. `IsOpenPreAuth` has no `default:`, so a new member fails to
    // compile there first; this covers the case where somebody adds one to the
    // "requires a session" block without thinking about whether it should be.
    // A member that is neither open nor session-requiring cannot exist — the
    // two are complements — so what is asserted is that the *count* the audit
    // walked still matches the union it walked.
    int members = 0;
    for (const auto v : SpringWeb::EnumValuesClientPayload()) {
        ++members;
        const uint8_t tag = static_cast<uint8_t>(v);
        INFO("verb: " << SpringWeb::EnumNameClientPayload(v)
                      << " (tag " << (int)tag << ")");
        CHECK(IsOpenPreAuth(tag) != RequiresSession(tag));
    }
    // 47 = NONE + 46 verbs. Bump this deliberately, having decided which side
    // of the gate the new verb belongs on. (46 → 47: ClientEvalResponse,
    // PLAN-test-automation P7 — session-requiring, see PreAuthPolicy.h.)
    CHECK(members == 47);
}

TEST_CASE("the sim-reaching verbs all require a session") {
    // Cross-check against the journal's independent classification rather than
    // re-listing the same verbs: anything that reaches the sim, or shapes who
    // may cause what, must be behind the gate. The two switches are written
    // apart and this is what ties them together.
    for (const auto v : SpringWeb::EnumValuesClientPayload()) {
        const uint8_t tag = static_cast<uint8_t>(v);
        const auto wire = syncedinput::ClassifyClientPayload(tag);
        if (wire != syncedinput::WireClass::Synced &&
            wire != syncedinput::WireClass::Setup)
            continue;
        INFO("verb: " << SpringWeb::EnumNameClientPayload(v));
        // Handshake and AuthRequest are Setup AND open — they are the two
        // admission verbs, and are the only permitted overlap.
        if (v == SpringWeb::ClientPayload_Handshake ||
            v == SpringWeb::ClientPayload_AuthRequest)
            continue;
        CHECK(RequiresSession(tag));
    }
}

TEST_CASE("an out-of-range tag requires a session") {
    // The flatbuffers verifier refuses these before dispatch, so this is about
    // the policy never answering "open" to something it does not recognise.
    CHECK(RequiresSession(
        static_cast<uint8_t>(SpringWeb::ClientPayload_MAX) + 1));
    CHECK(RequiresSession(200));
    CHECK(RequiresSession(255));
}

TEST_CASE("the empty tag is not open") {
    // ClientPayload_NONE is what a malformed or empty union reads as; letting
    // it past the gate would put an unparseable message into the switch's
    // `default` with no session behind it.
    CHECK(RequiresSession(SpringWeb::ClientPayload_NONE));
}
