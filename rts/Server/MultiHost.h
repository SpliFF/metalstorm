// MultiHost — entity ID encoding and inter-server handoff protocol.
//
// Per AGENTS.md resolved decisions, entity IDs are u32 with the upper
// 8 bits encoding server-origin (256 servers x 16M entities each).
//
//   Bits 31-24: server ID (0-255)
//   Bits 23-0:  local entity ID (0-16,777,215)
//
// When entities cross server boundaries, their state is serialized
// and sent to the receiving server via inter-server messaging.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <string>
#include <vector>

namespace MultiHost {

/// Extract the server ID from an entity ID.
constexpr uint8_t GetServerId(uint32_t entityId) {
  return static_cast<uint8_t>(entityId >> 24);
}

/// Extract the local entity ID from a full entity ID.
constexpr uint32_t GetLocalId(uint32_t entityId) {
  return entityId & 0x00FFFFFF;
}

/// Compose a full entity ID from server ID and local ID.
constexpr uint32_t MakeEntityId(uint8_t serverId, uint32_t localId) {
  return (static_cast<uint32_t>(serverId) << 24) | (localId & 0x00FFFFFF);
}

/// Check if an entity originated from a specific server.
constexpr bool IsFromServer(uint32_t entityId, uint8_t serverId) {
  return GetServerId(entityId) == serverId;
}

/// Maximum local entity IDs per server.
constexpr uint32_t MAX_LOCAL_ENTITIES = 0x00FFFFFF; // 16,777,215

/// Serialized entity state for inter-server handoff.
struct EntityHandoff {
  uint32_t entityId;
  uint16_t defId;
  uint8_t team;
  float3 position;
  float3 velocity;
  uint16_t heading;
  float health;
  float maxHealth;
  // Command queue snapshot
  std::vector<int> commandIds;
  std::vector<float> commandParams;
};

/// Server boundary definition.
struct ServerBoundary {
  uint8_t serverId;
  float minX, maxX;    // world-space X bounds
  float minZ, maxZ;    // world-space Z bounds
  std::string address; // network address of the server
  uint16_t port;
};

/// Check if a position is within a server boundary.
inline bool IsInBoundary(const ServerBoundary &boundary, const float3 &pos) {
  return pos.x >= boundary.minX && pos.x <= boundary.maxX &&
         pos.z >= boundary.minZ && pos.z <= boundary.maxZ;
}

} // namespace MultiHost
