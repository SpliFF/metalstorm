/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "StreamSink.h"
#include "Backend.h"

#include <iostream>
#include <ostream>
#include <string>
#include <cstring>


// Default the stream sink to stderr so every LOG_L() / LOG_SI() call
// shows up in the headless server's log file (and thus the mprocs
// game-logs panel, which tails those files). Without this default,
// the sink is registered but `logStreamInt` stayed NULL until some
// caller set it — which never happened after the client UI that used
// to wire `std::cout` was removed — and every log record was
// silently dropped. Callers can still override via the setter below.
static std::ostream* logStreamInt = &std::cerr;

void log_sink_stream_setLogStream(std::ostream* logStream) {
	logStreamInt = logStream;
}


#ifdef __cplusplus
extern "C" {
#endif

/**
 * @name logging_sink_stream
 * ILog.h sink implementation.
 */
///@{

/// Records a log entry
void log_sink_record_stream(int level, const char* section, const char* record)
{
	if (logStreamInt != NULL) {
		logStreamInt->write(record, strlen(record));
		(*logStreamInt) << std::endl;
	}
}

///@}


namespace {
	/// Auto-registers the sink defined in this file before main() is called
	struct StreamSinkRegistrator {
		StreamSinkRegistrator() {
			log_backend_registerSink(&log_sink_record_stream);
		}
		~StreamSinkRegistrator() {
			log_backend_unregisterSink(&log_sink_record_stream);
		}
	} streamSinkRegistrator;
}

#ifdef __cplusplus
} // extern "C"
#endif

