// AICommandCodec — the AI-command journal codec (replay chokepoint #4).
//
// Split out of StateStreamer.cpp by I1/SG1 (PLAN-ai-synced-write task 1) for
// one reason: the encoder/decoder pair is pure — it touches nothing but
// AICommand and std — while StateStreamer.cpp drags the whole game-server
// context, so the pair could not be round-trip tested by a doctest while it
// lived there. Adding an AICommandKind whose payload rides `text` is exactly
// the change that needs that test: a kind byte that did not survive the
// journal would have a replay silently apply a *different* verb.
#pragma once

#include <cstdint>
#include <vector>

#include "AICommandQueue.h"

/// Flatten one drained AICommand into the journal's opaque payload.
std::vector<uint8_t> SerializeAICommand(const AICommand& c);

/// Exact mirror of SerializeAICommand. False on any short/garbled buffer
/// rather than a partly-filled command.
bool DeserializeAICommand(const std::vector<uint8_t>& in, AICommand& out);
