#pragma once
// Server-build stub — word completion is a client-side UI feature.
#include <string>
struct WordCompletion {
	static void AddWord(const std::string&, bool, bool, bool) {}
	static void RemoveWord(const std::string&) {}
};
