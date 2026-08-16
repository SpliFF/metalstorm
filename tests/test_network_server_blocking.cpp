#include <doctest/doctest.h>

#include "Server/NetworkServer.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <string>
#include <thread>
#include <unistd.h>

// PLAN-metalstorm-command-language.md §3 / §9.2, milestone **M7** — "async
// worker pool if needed".
//
// The plan asks whether concurrent talkers hurt enough to justify a worker
// pool, and says a measured "no" is a fine answer. This file is the
// measurement, and it does not need an API key, a network or a game: the
// question is a property of `NetworkServer`, not of Claude.
//
// WHAT IT MEASURES. `NetworkServer` runs ONE network thread
// (`NetworkServer.cpp` — `networkThread = std::thread(&NetworkThreadFunc)`),
// and route handlers run synchronously on it (`H1ProcessRequest` → the inline
// `DispatchPost`/`DispatchGet` calls; the file's own comment says so:
// "handlers run synchronously on the network thread, so one request is in
// flight per thread at a time"). `NlProxy::Proxy::Call` blocks that thread on
// a `curl_easy_perform` with a 6-second timeout.
//
// So the question is not really "do two talkers contend". It is: **what else
// stops while ONE NL call is in flight?** These tests answer that with a
// number, by parking one handler for a known duration and timing an unrelated
// request that arrives during the pause.
//
// WHY IT MATTERS MORE THAN THE PLAN ASSUMED. §3 accepted "blocking the
// per-match HTTP thread" on the grounds that it degrades one match. That is
// true but understated: the same thread also drives this server's SSE
// channels, which is how game state reaches every client in the match. A
// blocked handler is not "that player waits" — it is "the match's state stream
// stalls for everyone in it". See the note in PLAN §7/M7 for what follows.
//
// The parked handler here sleeps rather than calling out, so the test is
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

}  // namespace

TEST_CASE("a parked route handler stalls every other route on the same server") {
    // 400 ms is roughly what the M4 acceptance run measured for one upstream
    // call that failed auth immediately (0.37–0.46 s, all DNS + TLS + a 401).
    // A real Claude parse is 1–3 s and the proxy's timeout is 6 s, so this is
    // the OPTIMISTIC end of the range being measured, not a worst case.
    constexpr int kParkMs = 400;

    NetworkServer server;
    std::atomic<bool> parkedRan{false};

    server.AddHttpGet("/slow", RouteAuth::Public, [&](const std::string&) {
        parkedRan = true;
        std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs));
        return HttpResponse{.contentType = "text/plain", .body = {'s', 'l', 'o', 'w'}, .status = 200};
    });
    server.AddHttpGet("/fast", RouteAuth::Public, [](const std::string&) {
        return HttpResponse{.contentType = "text/plain", .body = {'o', 'k'}, .status = 200};
    });

    const int port = FreePort(39000 + static_cast<int>(::getpid() % 2000));
    REQUIRE(port > 0);
    REQUIRE(server.Start(port));
    REQUIRE(WaitUntilListening(port));

    // Baseline: /fast with nothing else going on. This is what the route costs
    // when the thread is free, and it is the number the stall is measured
    // against — an absolute threshold would just be measuring this machine.
    const long long idle = TimeGet(port, "/fast");
    REQUIRE(idle >= 0);

    // Now park the thread and ask for /fast while it is parked.
    std::atomic<long long> blocked{-2};
    std::thread parker([&] { TimeGet(port, "/slow"); });
    // Long enough for the parked request to be accepted and dispatched, short
    // enough that most of the park is still ahead of us.
    std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs / 4));
    std::thread waiter([&] { blocked = TimeGet(port, "/fast"); });

    parker.join();
    waiter.join();
    server.Stop();

    REQUIRE(parkedRan.load());
    REQUIRE(blocked.load() >= 0);

    // THE MEASUREMENT. /fast does no work at all; if handlers ran off the
    // network thread it would answer in about `idle` regardless of what /slow
    // is doing. Instead it waits out the remainder of the park.
    //
    // Asserted loosely (half the park) because the exact overlap depends on
    // scheduling, and a flaky test in a 1000-case suite is worse than a
    // slightly weaker claim. The real numbers on an idle laptop are ~0-1 ms
    // idle versus ~300 ms blocked.
    MESSAGE("/fast idle=" << idle << "ms, during a " << kParkMs
            << "ms parked handler=" << blocked.load() << "ms");
    CHECK(blocked.load() > kParkMs / 2);
    CHECK(blocked.load() > idle + 100);
}

TEST_CASE("an SSE push made during a parked handler does not reach the client until it returns") {
    // The consequence that upgrades this from "that one player waits" to "the
    // match stalls": SSE frames are written from the same event loop, so a
    // parked handler holds back state the sim has already produced. In a real
    // match `/api/state` (or whichever channel the client tails) is how the
    // world moves, and this is the thread that flushes it.
    constexpr int kParkMs = 400;

    NetworkServer server;
    const uint32_t channel = server.AddSSE("/events");
    server.AddHttpGet("/slow", RouteAuth::Public, [&](const std::string&) {
        std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs));
        return HttpResponse{.contentType = "text/plain", .body = {'s'}, .status = 200};
    });

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

    std::thread parker([&] { TimeGet(port, "/slow"); });
    std::this_thread::sleep_for(std::chrono::milliseconds(kParkMs / 4));

    // SendSSE is documented thread-safe and returns immediately — the frame is
    // queued, not written. Writing it is the event loop's job, and the event
    // loop is asleep inside the parked handler.
    const auto pushedAt = std::chrono::steady_clock::now();
    server.SendSSE(channel, "{\"frame\":1}");

    const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
    const auto arrivedAfter = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - pushedAt).count();

    parker.join();
    ::close(fd);
    server.Stop();

    REQUIRE(n > 0);
    MESSAGE("SSE frame queued during a " << kParkMs << "ms parked handler arrived after "
            << arrivedAfter << "ms");
    // Same loose bound and the same reason as above.
    CHECK(arrivedAfter > kParkMs / 2);
}
