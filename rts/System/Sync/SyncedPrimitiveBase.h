/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef SYNCED_PRIMITIVE_BASE_H
#define SYNCED_PRIMITIVE_BASE_H

// Server-authoritative model: sync checking/debugging removed.
// These are no-op stubs for code that references them.

namespace Sync {
	template<typename T>
	static inline void Assert(const T&, const char* = "assert") {}

	static inline void Assert(const void*, unsigned, const char*) {}
}

#define ENTER_SYNCED_CODE()
#define LEAVE_SYNCED_CODE()
#define ASSERT_SYNCED(x)

#endif // SYNCED_PRIMITIVE_BASE_H
