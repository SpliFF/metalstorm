// ClientEvalBroker — the waiter table behind POST /api/client/eval
// (PLAN-test-automation P7). The properties tested here are the ones the
// route's safety rests on: a response may only resolve the request it was
// addressed for, a late response resolves nothing, and a timeout leaves no
// slot behind for a stranger to land in.

#include <doctest/doctest.h>

#include "Server/ClientEvalBroker.h"

#include <thread>

TEST_CASE("a delivered response resolves the waiter") {
    ClientEvalBroker broker;
    const uint32_t id = broker.Begin(/*targetClientId=*/7);
    CHECK(broker.PendingCount() == 1);

    std::thread responder([&] {
        // Deliver on another thread, as the sim thread does while the HTTP
        // thread is parked in Wait().
        for (int i = 0; i < 200; ++i) {
            if (broker.Deliver(id, 7, true, "42")) return;
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });

    bool success = false;
    std::string output;
    CHECK(broker.Wait(id, 2000, success, output));
    responder.join();
    CHECK(success);
    CHECK(output == "42");
    // The slot is erased on the way out, always.
    CHECK(broker.PendingCount() == 0);
}

TEST_CASE("a response from the wrong client resolves nothing") {
    ClientEvalBroker broker;
    const uint32_t id = broker.Begin(/*targetClientId=*/7);

    // Client 9 answers a request addressed to client 7 — stray or spoofed.
    CHECK_FALSE(broker.Deliver(id, 9, true, "i am not client 7"));

    bool success = true;
    std::string output = "untouched";
    // The waiter still times out: the impostor's answer was not accepted.
    CHECK_FALSE(broker.Wait(id, 30, success, output));
    CHECK(output == "untouched");
    CHECK(broker.PendingCount() == 0);
}

TEST_CASE("a late response finds no waiter") {
    ClientEvalBroker broker;
    const uint32_t id = broker.Begin(/*targetClientId=*/3);

    bool success = false;
    std::string output;
    CHECK_FALSE(broker.Wait(id, 20, success, output));   // timed out, slot erased
    CHECK(broker.PendingCount() == 0);

    // The browser answers eventually. Nothing to resolve — the caller logs and
    // drops it rather than writing into a reused slot.
    CHECK_FALSE(broker.Deliver(id, 3, true, "too late"));
}

TEST_CASE("unknown request ids are refused") {
    ClientEvalBroker broker;
    CHECK_FALSE(broker.Deliver(0xdeadbeef, 1, true, "never asked"));
}

TEST_CASE("request ids are unique and disjoint from the exec id space") {
    ClientEvalBroker broker;
    const uint32_t a = broker.Begin(1);
    const uint32_t b = broker.Begin(1);
    CHECK(a != b);
    // The top bit is set so a relay id can never be mistaken for one of the
    // browser console's own ConsoleCommand request ids in a log.
    CHECK((a & 0x80000000u) != 0);
    CHECK((b & 0x80000000u) != 0);
    CHECK(broker.PendingCount() == 2);
}

TEST_CASE("concurrent waiters resolve independently") {
    ClientEvalBroker broker;
    const uint32_t idA = broker.Begin(/*client=*/1);
    const uint32_t idB = broker.Begin(/*client=*/2);

    std::thread deliverer([&] {
        for (int i = 0; i < 400; ++i) {
            broker.Deliver(idB, 2, true, "B");
            broker.Deliver(idA, 1, false, "A failed");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });

    bool sa = true, sb = false;
    std::string oa, ob;
    const bool gotA = broker.Wait(idA, 2000, sa, oa);
    const bool gotB = broker.Wait(idB, 2000, sb, ob);
    deliverer.join();

    CHECK(gotA);
    CHECK(gotB);
    CHECK_FALSE(sa);
    CHECK(oa == "A failed");
    CHECK(sb);
    CHECK(ob == "B");
}
