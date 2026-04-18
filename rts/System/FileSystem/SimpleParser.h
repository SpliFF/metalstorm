/**
 * Stub — CSimpleParser provides string tokenization.
 */
#pragma once

#include <string>
#include <vector>
#include <sstream>

class CSimpleParser {
public:
	static std::vector<std::string> Tokenize(const std::string& text, int = 0) {
		std::vector<std::string> tokens;
		std::istringstream iss(text);
		std::string token;
		while (iss >> token) {
			tokens.push_back(token);
		}
		return tokens;
	}
};
