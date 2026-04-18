/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#ifndef PLATFORM_MESSAGEBOX_H
#define PLATFORM_MESSAGEBOX_H

// Message box flags
#define MBF_OK    0
#define MBF_EXCL  1
#define MBF_INFO  2
#define MBF_CRASH 4

namespace Platform {
	void MsgBox(const char* message, const char* caption, unsigned int flags);
}

#endif // PLATFORM_MESSAGEBOX_H
