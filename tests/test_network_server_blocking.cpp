#include <doctest/doctest.h>

#include "Server/NetworkServer.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>

// PLAN-metalstorm-command-language.md §7 — milestones **M7** (the measurement)
// and **M8** (the fix). This file is both, in that order: M7 wrote it to
// measure how badly a blocking handler hurt, and M8 flipped the assertions to
// prove it stopped hurting. It needs no API key, no network and no game — the
// question is a property of `NetworkServer`, not of Claude.
//
// WHAT M7 MEASURED. `NetworkServer` runs ONE network thread
// (`NetworkServer.cpp` — `networkThread = std::thread(&NetworkThreadFunc)`),
// dispatched route handlers inline on it, and flushes the SSE channels from
// that same loop. `NlProxy::Proxy::Call` blocks on a `curl_easy_perform` with
// a 6-second timeout. So the question was never "do two talkers contend" — it
// was **what else stops while ONE NL call is in flight**, and the answer was
// "everything": with a handler parked for 400 ms, an unrelated GET on another
// route took 307 ms and an SSE frame arrived 295 ms late. §3 accepted
// "blocking the per-match HTTP thread" as degrading one match; it actually
// froze every client's state stream in that match.
//
// WHAT M8 CHANGED. `AddHttpPostDeferred` — a handler may answer `std::nullopt`
// and complete a `DeferredResponse` from another thread, and the event loop
// writes the response when it lands. The handlers below therefore park a
// *worker*, not the network thread, and these tests now assert the ABSENCE of
// the stall: the unrelated GET answers in about its idle time, and the SSE
// frame arrives immediately rather than after the call returns. Both keep
// printing the measurement, so a regression is a number in the log and not
// just a red line.
//
// The parked worker sleeps rather than calling out, so the test stays
// hermetic and deterministic: no key, no upstream, no clock skew.

namespace {

/// A port nothing is listening on, found by binding a probe socket the same
/// way `NetworkServer` will (IPv6, dual-stack) and closing it again.
///
/// A fixed port would collide between parallel lanes, each of which runs its
/// own spring-tests; and `NetworkServer::Start` cannot be retried on failure
/// because it returns true unconditionally — the bind happens later, on the
/// network thread it just spawned. So the check has to happen before Start.
int FreePort(int from) {
    for (int port = from; port < from + 400; ++port) {
        const int fd = ::socket(AF_INET6, SOCK_STREAM, 0);
        if (fd < 0) continue;
        int zero = 0;
        ::setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &zero, sizeof(zero));
        sockaddr_in6 addr{};
        addr.sin6_family = AF_INET6;
        addr.sin6_addr = in6addr_any;
        addr.sin6_port = htons(static_cast<uint16_t>(port));
        const bool free_ = ::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
        ::close(fd);
        if (free_) return port;
    }
    return -1;
}

/// `Start` spawns the network thread and returns immediately, so the listen
/// socket does not exist yet when it returns. Poll until a connect succeeds.
/// (The first version of this file connected right after Start and measured a
/// connection-refused, which looks exactly like "the server is broken".)
bool WaitUntilListening(int port) {
    for (int attempt = 0; attempt < 200; ++attempt) {
        const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
        if (fd >= 0) {
            sockaddr_in addr{};
            addr.sin_family = AF_INET;
            addr.sin_port = htons(static_cast<uint16_t>(port));
            addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
            const bool up = ::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0;
            ::close(fd);
            if (up) return true;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    return false;
}

/// One HTTP/1.1 GET over loopback, returning the wall-clock milliseconds the
/// whole exchange took (-1 on failure). Deliberately raw sockets: this test is
/// about scheduling, and a client library with its own connection pooling or
/// retry would be measuring itself.
long long TimeGet(int port, const std::string& path) {
    const auto started = std::chrono::steady_clock::now();

    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }

    const std::string req = "GET " + path + " HTTP/1.1\r\nHost: localhost\r\n"
                            "Connection: close\r\n\r\n";
    if (::send(fd, req.data(), req.size(), 0) < 0) {
        ::close(fd);
        return -1;
    }

    // Read until the response headers are complete, NOT until EOF: this server
    // is keep-alive and does not close on `Connection: close`, so reading to
    // EOF hangs forever. Headers are what we are timing anyway — the point is
    // when the handler returned, and nothing is written before it does.
    // SO_RCVTIMEO is the backstop so a wedged server fails the test instead of
    // wedging the suite.
    timeval tv{};
    tv.tv_sec = 10;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string response;
    char buf[4096];
    while (response.find("\r\n\r\n") == std::string::npos) {
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, static_cast<size_t>(n));
    }
    ::close(fd);

    if (response.find("200 OK") == std::string::npos) return -1;
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
}

/// The same, for a POST — this is how the deferred route is exercised, since
/// `AddHttpPostDeferred` exists only for POST (see NetworkServer.h: a GET
/// handler cannot even carry the session token such a route needs).
long long TimePost(int port, const std::string& path, const std::string& body) {
    const auto started = std::chrono::steady_clock::now();

    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        ::close(fd);
        return -1;
    }

    const std::string req = "POST " + path + " HTTP/1.1\r\nHost: localhost\r\n"
                            "Content-Type: application/json\r\nContent-Length: " +
                            std::to_string(body.size()) + "\r\n\r\n" + body;
    if (::send(fd, req.data(), req.size(), 0) < 0) {
        ::close(fd);
        return -1;
    }

    timeval tv{};
    tv.tv_sec = 10;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string response;
    char buf[4096];
    while (response.find("\r\n\r\n") == std::string::npos) {
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, static_cast<size_t>(n));
    }
    ::close(fd);

    if (response.find("200 OK") == std::string::npos) return -1;
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
}

/// A deferred POST route that answers `body` after `parkMs` on a worker
/// thread — a stand-in for `NlProxy`'s call to Claude, minus the key, the
/// network and the money. Threads are collected so the test can join them:
/// a detached worker outliving the doctest case would be racing the harness.
struct ParkedRoute {
    std::vector<std::thread> workers;
    std::atomic<int> dispatched{0};

    void Register(NetworkServer& server, const std::string& pattern, int parkMs,
                  std::string body = "slow") {
        server.AddHttpPostDeferred(pattern, RouteAuth::Public,
            [this, parkMs, body](const std::string&, const std::string&,
                                 const HttpRequestHeaders&,
                                 const DeferredResponse& defer) -> std::optional<HttpResponse> {
                ++dispatched;
                // Handlers only ever run on the network thread, so this vector
                // needs no lock — the whole point of the milestone is that the
                // thread gets straight back to the event loop from here.
                workers.emplace_back([defer, parkMs, body] {
                    std::this_thread::sleep_for(std::chrono::milliseconds(parkMs));
                    defer.Complete(HttpResponse{.contentType = "text/plain",
                                                .body = {body.begin(), body.end()},
                                                .status = 200});
                });
                return std::nullopt;   // "not yet" — the handle carries the answer
            });
    }

    void Join() {
        for (auto& t : workers)
            if (t.joinable()) t.join();
        workers.clear();
    }
};

}  // namespace

TEST_CASE("a parked deferred handler leaves every other route on the same server responsive") {
    // 400 ms is roughly what the M4 acceptance run measured for one upstream
    // call that failed auth immediately (0.37–0.46 s, all DNS + TLS + a 401).
    // A real Claude parse is 1–3 s and the proxy's timeout is 6 s, so this is
    // the OPTIMISTIC end of the range being measured, not a worst case.
    constexpr int kParkMs = 400;

    NetworkServer server;
    ParkedRoute parked;
    parked.Register(server, "/slow", kParkMs);
    server.AddHttpGet("/fast", RouteAuth::Public, [](const std::string&) {
        return HttpResponse{.contentType = "text/plain", .body = {'o', 'k'}, .status = 200};
    });

    const int port = FreePort(39000 + static_cast<int>(::getpid() % 2000));
    REQUIRE(port > 0);
    REQUIRE(server.Start(port));
    REQUIRE(WaitUntilListening(port));

    // Baseline: /fast with nothing else going on. This is what the route costs
    // when the thread is free, and it is the number the absence of a stall is
    // measured against — an absolute threshold would just be measuring this
    // machine.
    const long long idle = TimeGet(port, "/fast");
    REQUIRE(idle >= 0);

    // Now park a call and ask for /fast while it is in flight.
    std::atomic<long long> during{-2};
    std::atomic<long long> deferredTook{-2};
    std::thread parker([&] { deferredTook = TimePost(port, "/slow", "{}"); });
    // Long enough for the parked request to be accepted and dispatched, short
    // enough that most of the park is still ahead of us.
    std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs / 4));
    std::thread waiter([&] { during = TimeGet(port, "/fast"); });

    parker.join();
    waiter.join();
    parked.Join();
    server.Stop();

    REQUIRE(parked.dispatched.load() == 1);
    REQUIRE(during.load() >= 0);

    // THE MEASUREMENT, INVERTED (M8). /fast does no work at all, and with the
    // handler off the network thread it now answers in about `idle` no matter
    // what /slow is doing. Before M8 this same line read
    // `CHECK(during > kParkMs / 2)` and measured ~307 ms.
    //
    // The bound is generous — a quarter of the park, i.e. 100 ms for a call
    // that takes 400 — because this is a wall-clock test in a suite that runs
    // alongside a thousand others, and it only has to separate "answered
    // immediately" from "waited out someone else's 400 ms call". A flaky test
    // is worse than a slightly weaker claim. Real numbers on an idle laptop
    // are ~0–1 ms both times.
    MESSAGE("/fast idle=" << idle << "ms, during a " << kParkMs
            << "ms parked deferred handler=" << during.load() << "ms");
    CHECK(during.load() < kParkMs / 4);

    // And the deferred request itself still gets its answer, late but correct
    // — "responsive" must not have been bought by dropping the response.
    MESSAGE("the deferred POST itself answered after " << deferredTook.load() << "ms");
    CHECK(deferredTook.load() >= kParkMs);
}

TEST_CASE("an SSE push made during a parked deferred handler reaches the client immediately") {
    // The consequence that made M7's finding "the match stalls" rather than
    // "that one player waits": SSE frames are written from the same event
    // loop, so an inline-blocking handler held back state the sim had already
    // produced. In a real match `/api/state` (or whichever channel the client
    // tails) is how the world moves, and this is the thread that flushes it.
    // With the call deferred, the loop is free to flush it on schedule.
    constexpr int kParkMs = 400;

    NetworkServer server;
    const uint32_t channel = server.AddSSE("/events");
    ParkedRoute parked;
    parked.Register(server, "/slow", kParkMs);

    const int port = FreePort(39500 + static_cast<int>(::getpid() % 2000));
    REQUIRE(port > 0);
    REQUIRE(server.Start(port));
    REQUIRE(WaitUntilListening(port));

    // Subscribe, then hold the connection open and read.
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    REQUIRE(fd >= 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    REQUIRE(::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    timeval tv{};
    tv.tv_sec = 10;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    const std::string req = "GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n";
    REQUIRE(::send(fd, req.data(), req.size(), 0) > 0);

    // Drain the SSE response headers so the next read is the event itself.
    char buf[4096];
    std::string seen;
    while (seen.find("\r\n\r\n") == std::string::npos) {
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        seen.append(buf, static_cast<size_t>(n));
    }
    REQUIRE(seen.find("200 OK") != std::string::npos);

    std::thread parker([&] { TimePost(port, "/slow", "{}"); });
    std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs / 4));

    // SendSSE is documented thread-safe and returns immediately — the frame is
    // queued, not written. Writing it is the event loop's job, and the event
    // loop is now back in poll() rather than asleep inside a handler.
    const auto pushedAt = std::chrono::steady_clock::now();
    server.SendSSE(channel, "{\"frame\":1}");

    const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    const auto arrivedAfter = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - pushedAt).count();

    parker.join();
    parked.Join();
    ::close(fd);
    server.Stop();

    REQUIRE(n > 0);
    MESSAGE("SSE frame queued during a " << kParkMs << "ms parked deferred handler arrived after "
            << arrivedAfter << "ms");
    // INVERTED (M8): this line used to read `CHECK(arrivedAfter > kParkMs / 2)`
    // and measured 295 ms. The remaining ceiling is the event loop's own 100 ms
    // poll timeout plus slack — SendSSE pokes the wake pipe, so in practice the
    // frame goes out in single-digit milliseconds.
    CHECK(arrivedAfter < kParkMs / 2);
}

TEST_CASE("a client that disconnects mid-call cancels its deferred response") {
    // The lifetime question the milestone turned on (§7/M8). `connections` is
    // keyed by fd and the kernel recycles fds hard, so a completion arriving
    // 1–3 s after its client hung up must NOT be written to whatever now owns
    // that number. Pending handles are matched on a never-reused connection
    // id instead, and CloseConnection poisons them.
    //
    // What this asserts is deliberately modest: the worker completes into a
    // cancelled handle, the server survives it, and it keeps serving. Under
    // ASan (which CI builds) a write into a freed connection would be a
    // use-after-free here rather than a silent corruption in production.
    constexpr int kParkMs = 300;

    NetworkServer server;
    ParkedRoute parked;
    parked.Register(server, "/slow", kParkMs);
    server.AddHttpGet("/fast", RouteAuth::Public, [](const std::string&) {
        return HttpResponse{.contentType = "text/plain", .body = {'o', 'k'}, .status = 200};
    });

    const int port = FreePort(40000 + static_cast<int>(::getpid() % 2000));
    REQUIRE(port > 0);
    REQUIRE(server.Start(port));
    REQUIRE(WaitUntilListening(port));

    // Post, then hang up without reading the answer.
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    REQUIRE(fd >= 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    REQUIRE(::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    const std::string req = "POST /slow HTTP/1.1\r\nHost: localhost\r\n"
                            "Content-Length: 2\r\n\r\n{}";
    REQUIRE(::send(fd, req.data(), req.size(), 0) > 0);

    // Give the server time to accept and dispatch, then vanish.
    std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs / 4));
    ::close(fd);

    // Churn connections while the doomed call is still in flight, so the
    // original fd number is plausibly back in circulation by the time the
    // worker completes.
    for (int i = 0; i < 5; ++i) CHECK(TimeGet(port, "/fast") >= 0);

    parked.Join();                       // the worker completes into a dead handle
    std::this_thread::sleep_for(std::chrono::milliseconds(50));  // ≥ one poll tick

    REQUIRE(parked.dispatched.load() == 1);
    // Still alive and still serving, which is the whole claim.
    CHECK(TimeGet(port, "/fast") >= 0);
    server.Stop();
}

TEST_CASE("a deferred handler that throws answers 500 once, and the late completion is dropped") {
    // `SafeInvoke` is the guard that stops one malformed request from killing
    // a match (the room-abandon type_error crash). A deferred route must not
    // reopen that hole, and it has TWO halves that can throw. This covers the
    // nastier half: the handler spawns its worker and THEN throws. The
    // dispatcher must write the 500 *and* poison the handle, or the connection
    // gets a second response written onto it a moment later.
    NetworkServer server;
    std::vector<std::thread> workers;

    server.AddHttpPostDeferred("/throws", RouteAuth::Public,
        [&workers](const std::string&, const std::string&, const HttpRequestHeaders&,
                   const DeferredResponse& defer) -> std::optional<HttpResponse> {
            workers.emplace_back([defer] {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                defer.Complete(HttpResponse{.contentType = "text/plain",
                                            .body = {'l', 'a', 't', 'e'}, .status = 200});
            });
            throw std::runtime_error("handler threw after handing off");
        });
    server.AddHttpGet("/fast", RouteAuth::Public, [](const std::string&) {
        return HttpResponse{.contentType = "text/plain", .body = {'o', 'k'}, .status = 200};
    });

    const int port = FreePort(40500 + static_cast<int>(::getpid() % 2000));
    REQUIRE(port > 0);
    REQUIRE(server.Start(port));
    REQUIRE(WaitUntilListening(port));

    // TimePost only accepts 200, so read this one by hand.
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    REQUIRE(fd >= 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port));
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    REQUIRE(::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    timeval tv{};
    tv.tv_sec = 5;
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    const std::string req = "POST /throws HTTP/1.1\r\nHost: localhost\r\n"
                            "Content-Length: 2\r\n\r\n{}";
    REQUIRE(::send(fd, req.data(), req.size(), 0) > 0);

    std::string response;
    char buf[4096];
    while (response.find("\r\n\r\n") == std::string::npos) {
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        response.append(buf, static_cast<size_t>(n));
    }
    CHECK(response.find("500 Internal Server Error") != std::string::npos);

    // Let the worker's late Complete() land, then confirm nothing else was
    // written to this connection — one request, one response.
    for (auto& t : workers) t.join();
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    const ssize_t extra = ::recv(fd, buf, sizeof(buf), MSG_DONTWAIT);
    CHECK(extra <= 0);
    CHECK(response.find("late") == std::string::npos);
    ::close(fd);

    CHECK(TimeGet(port, "/fast") >= 0);   // the process survived the throw
    server.Stop();
}
