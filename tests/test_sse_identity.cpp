#include <doctest/doctest.h>

#include "Server/NetworkServer.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <thread>

// PLAN-lobby.md §3.2, task 9b — identified SSE subscribers.
//
// This one runs over a real socket, deliberately. The rest of 9b is store
// logic and can be driven in-process, but the property that matters here is
// *who receives a frame*, and that is decided inside DrainSSEQueue against
// per-connection state that no in-process hook can stand up honestly. A test
// that mocked it would be asserting the mock's fan-out rule.
//
// Three rules, and each is a way chat leaks if it is wrong:
//   * an identified channel REFUSES an unresolved stream (401) instead of
//     admitting it anonymously — an admitted stream receives every broadcast
//     on the channel;
//   * a targeted send reaches only the named subscribers;
//   * a targeted send with an EMPTY recipient list reaches NOBODY. That case
//     is not hypothetical: it is what "everyone in the room ignored this
//     sender" and "the only other party to this PM is offline" both produce,
//     and the natural `if (recipients.empty()) broadcast` reading turns
//     exactly those into a broadcast.

namespace {

int ConnectTo(int port) {
    const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(fd, (sockaddr*)&addr, sizeof(addr)) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

bool SendAll(int fd, const std::string& s) {
    size_t sent = 0;
    while (sent < s.size()) {
        const ssize_t n = ::send(fd, s.data() + sent, s.size() - sent, 0);
        if (n <= 0) return false;
        sent += (size_t)n;
    }
    return true;
}

/// Read whatever arrives within `ms`. Never blocks past the deadline — an SSE
/// stream is never "done", so a test can only ever ask what showed up in a
/// window.
std::string ReadFor(int fd, int ms) {
    std::string out;
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(ms);
    while (std::chrono::steady_clock::now() < deadline) {
        pollfd p{fd, POLLIN, 0};
        const int remaining = (int)std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (::poll(&p, 1, remaining > 0 ? remaining : 0) <= 0) continue;
        char buf[4096];
        const ssize_t n = ::recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;
        out.append(buf, (size_t)n);
    }
    return out;
}

/// Open an SSE stream and return the socket plus its response head.
int OpenStream(int port, const std::string& path, std::string& head) {
    const int fd = ConnectTo(port);
    if (fd < 0) return -1;
    REQUIRE(SendAll(fd, "GET " + path + " HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    head = ReadFor(fd, 300);
    return fd;
}

}  // namespace

TEST_CASE("task 9b: an identified SSE channel refuses, targets, and never broadcasts an empty target") {
    NetworkServer net;
    const uint32_t anonChan = net.AddSSE("/api/rooms/stream");
    const uint32_t chatChan = net.AddIdentifiedSSE("/api/chat/stream");
    net.SetSSESubscriberResolver([](const std::string& query) -> int64_t {
        // Stands in for SSETickets::Redeem — the resolver contract is "query
        // string in, account id out, 0 refuses".
        if (query == "ticket=alice") return 1;
        if (query == "ticket=bob") return 2;
        return 0;
    });

    // Take whichever loopback port is free; a fixed one makes the suite fail
    // for reasons that have nothing to do with the code under test.
    int port = 0;
    for (int candidate = 18700; candidate < 18720; candidate++) {
        if (!net.Start(candidate)) continue;
        for (int attempt = 0; attempt < 40 && port == 0; attempt++) {
            const int probe = ConnectTo(candidate);
            if (probe >= 0) { ::close(probe); port = candidate; break; }
            std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
        if (port != 0) break;
        net.Stop();
    }
    REQUIRE(port != 0);

    SUBCASE("an unresolved stream is refused rather than admitted anonymously") {
        std::string head;
        const int fd = OpenStream(port, "/api/chat/stream", head);
        REQUIRE(fd >= 0);
        CHECK(head.find("401") != std::string::npos);
        CHECK(head.find("text/event-stream") == std::string::npos);
        ::close(fd);

        std::string head2;
        const int fd2 = OpenStream(port, "/api/chat/stream?ticket=nobody", head2);
        REQUIRE(fd2 >= 0);
        CHECK(head2.find("401") != std::string::npos);
        ::close(fd2);

        // And a refused connection is not on the channel: a broadcast after
        // the refusal must not reach it.
        const int fd3 = ConnectTo(port);
        REQUIRE(fd3 >= 0);
        REQUIRE(SendAll(fd3, "GET /api/chat/stream?ticket=nobody HTTP/1.1\r\n"
                             "Host: localhost\r\n\r\n"));
        (void)ReadFor(fd3, 200);
        net.SendSSE(chatChan, R"({"x":1})", "chat");
        CHECK(ReadFor(fd3, 300).find("x") == std::string::npos);
        ::close(fd3);
    }

    SUBCASE("a targeted send reaches the named subscriber and nobody else") {
        std::string aliceHead, bobHead;
        const int alice = OpenStream(port, "/api/chat/stream?ticket=alice", aliceHead);
        const int bob = OpenStream(port, "/api/chat/stream?ticket=bob", bobHead);
        REQUIRE(alice >= 0);
        REQUIRE(bob >= 0);
        CHECK(aliceHead.find("text/event-stream") != std::string::npos);
        CHECK(bobHead.find("text/event-stream") != std::string::npos);

        net.SendSSETo(chatChan, {1}, R"({"text":"for-alice"})", "chat");
        const std::string a = ReadFor(alice, 400);
        const std::string b = ReadFor(bob, 400);
        CHECK(a.find("for-alice") != std::string::npos);
        CHECK(a.find("event: chat") != std::string::npos);
        CHECK(b.find("for-alice") == std::string::npos);

        // Both named: a room channel's fan-out.
        net.SendSSETo(chatChan, {1, 2}, R"({"text":"for-both"})", "chat");
        CHECK(ReadFor(alice, 400).find("for-both") != std::string::npos);
        CHECK(ReadFor(bob, 400).find("for-both") != std::string::npos);

        // An untargeted send on the same channel still broadcasts — the
        // system lines a channel emits about itself have no recipient list.
        net.SendSSE(chatChan, R"({"text":"to-everyone"})", "chat");
        CHECK(ReadFor(alice, 400).find("to-everyone") != std::string::npos);
        CHECK(ReadFor(bob, 400).find("to-everyone") != std::string::npos);

        ::close(alice);
        ::close(bob);
    }

    SUBCASE("an empty recipient list delivers to nobody, not to everybody") {
        std::string aliceHead, bobHead;
        const int alice = OpenStream(port, "/api/chat/stream?ticket=alice", aliceHead);
        const int bob = OpenStream(port, "/api/chat/stream?ticket=bob", bobHead);
        REQUIRE(alice >= 0);
        REQUIRE(bob >= 0);

        net.SendSSETo(chatChan, {}, R"({"text":"nobody-asked"})", "chat");
        CHECK(ReadFor(alice, 400).find("nobody-asked") == std::string::npos);
        CHECK(ReadFor(bob, 400).find("nobody-asked") == std::string::npos);

        // A recipient nobody is connected as is the same case: no frame, and
        // no fallback to the people who are here.
        net.SendSSETo(chatChan, {99}, R"({"text":"for-a-ghost"})", "chat");
        CHECK(ReadFor(alice, 400).find("for-a-ghost") == std::string::npos);
        CHECK(ReadFor(bob, 400).find("for-a-ghost") == std::string::npos);

        ::close(alice);
        ::close(bob);
    }

    SUBCASE("an anonymous channel is unchanged by any of this") {
        // The room stream carries the same document to everybody and has no
        // ticket. It must keep working exactly as it did.
        std::string head;
        const int fd = OpenStream(port, "/api/rooms/stream", head);
        REQUIRE(fd >= 0);
        CHECK(head.find("text/event-stream") != std::string::npos);
        net.SendSSE(anonChan, R"({"rooms":[]})", "rooms");
        CHECK(ReadFor(fd, 400).find("rooms") != std::string::npos);

        // …and it is not addressable: an anonymous subscriber has no identity
        // to be named by, so a targeted send on it reaches no one.
        net.SendSSETo(anonChan, {1}, R"({"secret":true})", "rooms");
        CHECK(ReadFor(fd, 300).find("secret") == std::string::npos);
        ::close(fd);
    }

    net.Stop();
}
