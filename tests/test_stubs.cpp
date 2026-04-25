// Stubs for symbols that live in Server sources (not linked into tests)

#include <string>
#include <unordered_map>

// LuaSyncedRead references gAITeams (defined in Server/Simulation.cpp)
const std::unordered_map<int, std::string>* gAITeams = nullptr;
