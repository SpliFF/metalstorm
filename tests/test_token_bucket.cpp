// PLAN-security-hardening task 11 (G10): the shared token bucket that brakes
// /api/rooms/start fork/exec. Time is injected so the refill behaviour is
// deterministic (no sleeps).

#include <doctest/doctest.h>

#include <chrono>

#include "Server/TokenBucket.h"

using Clock = std::chrono::steady_clock;
// Base the injected timeline on the real clock: a fresh TokenBucket seeds its
// internal `last_` to construction-time now(), so the first injected `now` must
// be ≈ that, not the epoch (which would read as an enormous negative elapsed).
static Clock::time_point T0() { return Clock::now(); }

TEST_CASE("TokenBucket allows a full burst then blocks") {
	TokenBucket tb(/*burst=*/10.0, /*perSecond=*/10.0 / 60.0);
	auto t = T0();
	for (int i = 0; i < 10; ++i)
		CHECK(tb.TryConsume(t));   // burst of 10 all succeed at the same instant
	CHECK_FALSE(tb.TryConsume(t)); // 11th at the same instant is refused
}

TEST_CASE("TokenBucket refills at the configured rate") {
	TokenBucket tb(/*burst=*/10.0, /*perSecond=*/10.0 / 60.0);  // ~1 token / 6s
	auto t = T0();
	for (int i = 0; i < 10; ++i) CHECK(tb.TryConsume(t));  // drain the burst
	CHECK_FALSE(tb.TryConsume(t));

	// After 6 seconds exactly one token has regenerated.
	t += std::chrono::seconds(6);
	CHECK(tb.TryConsume(t));
	CHECK_FALSE(tb.TryConsume(t));

	// After a long idle the bucket refills only up to the burst cap, not beyond.
	t += std::chrono::hours(1);
	for (int i = 0; i < 10; ++i) CHECK(tb.TryConsume(t));
	CHECK_FALSE(tb.TryConsume(t));
}
