/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

// Stub — archive loading (VFS/zip) removed from the server build.
// LuaZip.cpp references archiveLoader.OpenArchive; this stub satisfies the
// dependency without pulling in the full archive subsystem.

#pragma once
#include "System/FileSystem/Archives/IArchive.h"
#include <string>

struct CArchiveLoader {
	IArchive* OpenArchive(const std::string& /*filename*/, const std::string& /*type*/ = "") const {
		return nullptr;
	}
};

// Global instance expected by LuaZip.cpp
inline CArchiveLoader archiveLoader;
