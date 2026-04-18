/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include <string>
#include <algorithm>


#include "Action.h"

Action::Action(const std::string& line)
	: rawline(line)
{
	// Split line into at most two tokens: command and remainder
	const size_t firstSpace = line.find_first_of(" \t");
	std::string cmd = (firstSpace == std::string::npos) ? line : line.substr(0, firstSpace);

	command.resize(cmd.length());
	std::transform(cmd.begin(), cmd.end(), command.begin(), (int (*)(int))tolower);

	if (firstSpace != std::string::npos) {
		const size_t extraStart = line.find_first_not_of(" \t", firstSpace);
		if (extraStart != std::string::npos)
			extra = line.substr(extraStart);
	}
}
