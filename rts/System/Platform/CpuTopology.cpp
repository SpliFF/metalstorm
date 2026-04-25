#include "CpuTopology.h"

namespace cpu_topology {

ThreadPinPolicy GetThreadPinPolicy() { return THREAD_PIN_POLICY_NONE; }
ProcessorMasks GetProcessorMasks() { return {}; }
ProcessorCaches GetProcessorCache() { return {}; }

}
