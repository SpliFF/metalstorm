/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * ScopedFPUSettings stub — streflop and FPU mode switching have been removed.
 * The server uses standard IEEE floating-point throughout.
 * This header provides no-op RAII wrappers to satisfy existing call sites.
 */

#pragma once

struct ScopedDisableFpuExceptions {
	ScopedDisableFpuExceptions()  {}
	~ScopedDisableFpuExceptions() {}
};

struct ScopedRestoreFpuExceptions {
	ScopedRestoreFpuExceptions()  {}
	~ScopedRestoreFpuExceptions() {}
};
