/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef SIM_FRAME_PROFILER_H
#define SIM_FRAME_PROFILER_H

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <sstream>
#include <string>

#include "System/Misc/SpringTime.h"

/// Snapshot of one phase's accumulators (or the whole frame), as returned by
/// GetPhase()/GetFrame(). A free-standing struct, not nested in
/// SimFrameProfiler — a nested type's default member initializers aren't
/// visible yet when the enclosing class declares a same-scope array of it
/// (`default_member_initializer_not_yet_parsed`).
struct SimFramePhaseStats {
	uint64_t samples = 0;
	double totalUs = 0.0;
	double maxUs = 0.0;
};

/// Atomic backing store for one phase. Written only by the sim thread; read
/// concurrently by the network thread (/api/metrics in GameHttpRoutes).
/// Single writer, so plain load+store (no RMW) with relaxed ordering
/// suffices — the atomics exist to make the cross-thread reads well-defined,
/// not to order them.
struct SimFramePhaseAtomics {
	std::atomic<uint64_t> samples{0};
	std::atomic<double> totalUs{0.0};
	std::atomic<double> maxUs{0.0};
};

/**
 * SimFrameProfiler — per-frame phase breakdown of CSimulation::SimFrame().
 *
 * PLAN-server-cpp-optimisation.md P0: the gate-free prerequisite for the
 * whole plan. Before anything is ported/batched, this answers "of the
 * 33.3ms sim budget, how much is native C++ sim, how much is unit-script
 * ticking (COB + Lua LUS), and how much is synced Lua call-ins (LuaRules /
 * LuaGaia GameFrame + gadget dispatch)". Complements LuaCallInProfiler
 * (per handle+callin detail, wherever a call-in fires) with the coarse
 * phase split that SimFrame's own structure already gives for free.
 *
 * Threading: written from the sim thread only (same as LuaCallInProfiler),
 * but read concurrently by the network thread — /api/metrics polls
 * GetFrame()/GetPhase() live. Every counter is a relaxed std::atomic with a
 * single writer; no locking. A reader may catch a frame mid-record (e.g.
 * samples already bumped, totalUs not yet) — momentary one-frame skew is
 * fine for a metrics poll. Disabled by default; per-frame cost when off is
 * one relaxed atomic load (IsEnabled) + 3 skipped spring_now() pairs.
 */
class SimFrameProfiler {
public:
	enum Phase {
		// eventHandler.CollectGarbage(false) + eventHandler.GameFrame(frame) —
		// the LuaRules/LuaGaia GameFrame call-in, which is where gadgetHandler
		// dispatches every synced gadget's per-frame work.
		Phase_LuaGameFrame = 0,
		// unitScriptEngine->Tick() — per-unit animation stepping. Covers BOTH
		// the native COB VM and Lua unit-script (LUS) coroutines; whichever a
		// unit uses, its cost lands here.
		Phase_UnitScript,
		// Everything else: helper/mapDamage/pathManager, unitHandler,
		// projectileHandler, featureHandler, envResHandler, losHandler,
		// interceptHandler, team/player GameFrame hooks, waitCommandsAI. Pure
		// C++, though some of it (e.g. unitHandler.Update()) can itself
		// trigger synced call-ins (UnitCreated/UnitDamaged/AllowCommand/...) —
		// that nested Lua time is counted here at the phase level, but is
		// also visible per-callin in LuaCallInProfiler.
		Phase_NativeSim,
		Phase_Count
	};

	using PhaseStats = SimFramePhaseStats;

	static bool IsEnabled() { return enabled_.load(std::memory_order_relaxed); }
	static void SetEnabled(bool on) { enabled_.store(on, std::memory_order_relaxed); }

	static void RecordPhase(Phase p, double us) { Accumulate(phases_[p], us); }

	static void RecordFrame(double us) { Accumulate(frame_, us); }

	static void Reset() {
		for (auto& p : phases_)
			Clear(p);
		Clear(frame_);
	}

	static PhaseStats GetPhase(Phase p) { return Snapshot(phases_[p]); }
	static PhaseStats GetFrame() { return Snapshot(frame_); }

	static const char* PhaseName(Phase p) {
		switch (p) {
			case Phase_LuaGameFrame: return "lua-gameframe";
			case Phase_UnitScript:   return "unit-script";
			case Phase_NativeSim:    return "native-sim";
			default:                 return "?";
		}
	}

	/// Human-readable report for the `server sim profile` console verb.
	static std::string Report() {
		std::ostringstream ss;
		const PhaseStats frame = GetFrame();
		ss << "sim profile: " << (IsEnabled() ? "on" : "off")
		   << ", " << frame.samples << " frame(s) sampled\n";

		if (frame.samples == 0) {
			ss << "(no samples — enable with `server sim profile on`)\n";
			return ss.str();
		}

		const double avgFrameUs = frame.totalUs / static_cast<double>(frame.samples);
		char buf[256];
		snprintf(buf, sizeof(buf),
		         "frame avg %.1f us (%.3f ms), max %.1f us, implied %.1f Hz (30 Hz budget = 33333 us)\n",
		         avgFrameUs, avgFrameUs / 1000.0, frame.maxUs,
		         avgFrameUs > 0.0 ? 1.0e6 / avgFrameUs : 0.0);
		ss << buf;

		ss << "phase                  calls    avg_us    max_us   share_of_frame\n";
		for (int i = 0; i < Phase_Count; ++i) {
			const PhaseStats e = GetPhase(static_cast<Phase>(i));
			const double avgUs = e.samples != 0 ? e.totalUs / static_cast<double>(e.samples) : 0.0;
			const double share = frame.totalUs > 0.0 ? (100.0 * e.totalUs / frame.totalUs) : 0.0;
			snprintf(buf, sizeof(buf), "%-20s %8llu %9.1f %9.1f %13.1f%%\n",
			         PhaseName(static_cast<Phase>(i)),
			         static_cast<unsigned long long>(e.samples), avgUs, e.maxUs, share);
			ss << buf;
		}
		return ss.str();
	}

private:
	// Sim thread is the only writer — load+store instead of RMW is deliberate.
	static void Accumulate(SimFramePhaseAtomics& e, double us) {
		e.samples.store(e.samples.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
		e.totalUs.store(e.totalUs.load(std::memory_order_relaxed) + us, std::memory_order_relaxed);
		if (us > e.maxUs.load(std::memory_order_relaxed))
			e.maxUs.store(us, std::memory_order_relaxed);
	}

	static void Clear(SimFramePhaseAtomics& e) {
		e.samples.store(0, std::memory_order_relaxed);
		e.totalUs.store(0.0, std::memory_order_relaxed);
		e.maxUs.store(0.0, std::memory_order_relaxed);
	}

	static PhaseStats Snapshot(const SimFramePhaseAtomics& e) {
		PhaseStats s;
		s.samples = e.samples.load(std::memory_order_relaxed);
		s.totalUs = e.totalUs.load(std::memory_order_relaxed);
		s.maxUs = e.maxUs.load(std::memory_order_relaxed);
		return s;
	}

	static inline std::atomic<bool> enabled_{false};
	static inline SimFramePhaseAtomics phases_[Phase_Count];
	static inline SimFramePhaseAtomics frame_;
};

#endif // SIM_FRAME_PROFILER_H
