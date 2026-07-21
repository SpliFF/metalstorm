/* TokenBucket — a tiny thread-safe token-bucket rate limiter.
 *
 * PLAN-security-hardening task 11 (G10). A generalisation of the ad-hoc bucket
 * baked into HttpAuth.h's RegistrationLimiter (task 3, G5), pulled out so the
 * room/process-spawn gate can share the same shape and so the behaviour is unit
 * testable. Tokens refill lazily on each TryConsume() at `perSecond`, capped at
 * `burst`; TryConsume() returns false when the bucket is empty.
 *
 * Header-only (drops into the rts/Server glob without a new TU) and dependency
 * free, so it links into spring-tests as-is.
 */
#pragma once

#include <algorithm>
#include <chrono>
#include <mutex>

class TokenBucket {
public:
	TokenBucket(double burst, double perSecond)
		: burst_(burst), perSecond_(perSecond), tokens_(burst) {}

	/// Try to take one token. Returns true if one was available (and consumes
	/// it), false if the bucket is currently empty. `now` is injectable for
	/// deterministic tests; defaults to the steady clock.
	bool TryConsume(std::chrono::steady_clock::time_point now =
			std::chrono::steady_clock::now()) {
		std::lock_guard<std::mutex> lock(mutex_);
		const double elapsed = std::chrono::duration<double>(now - last_).count();
		last_ = now;
		tokens_ = std::min(burst_, tokens_ + elapsed * perSecond_);
		if (tokens_ < 1.0) return false;
		tokens_ -= 1.0;
		return true;
	}

private:
	const double burst_;
	const double perSecond_;
	double tokens_;
	std::chrono::steady_clock::time_point last_ = std::chrono::steady_clock::now();
	std::mutex mutex_;
};
