/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * @brief error messages
 * Error handling based on platform.
 */


#include "errorhandler.h"

#include <string>
#include <functional>

#include "System/SpringExitCode.h"
#include "System/Log/ILog.h"
#include "System/Log/LogSinkHandler.h"
#include "System/Threading/SpringThreading.h"

static void ExitSpringProcessAux(bool waitForExit, bool exitSuccess)
{
	// wait a bit before forcing the kill
	if (waitForExit)
		spring::this_thread::sleep_for(std::chrono::seconds(5));

	logSinkHandler.SetSinking(false);

#ifdef _MSC_VER
	if (!exitSuccess)
		TerminateProcess(GetCurrentProcess(), spring::EXIT_CODE_CRASHED);
#endif

	exit(spring::EXIT_CODE_CRASHED);
}


static void ExitSpringProcess(const char* msg, const char* caption, unsigned int flags)
{
	LOG_L(L_ERROR, "[%s] errorMsg=\"%s\" msgCaption=\"%s\"", __func__, msg, caption);
	ExitSpringProcessAux(false, false);
}


void ErrorMessageBox(const char* msg, const char* caption, unsigned int flags)
{
	ExitSpringProcess(msg, caption, flags);
}

