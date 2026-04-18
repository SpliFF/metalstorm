/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

#include "System/GlobalConfig.h"

#ifndef UNITSYNC
#include "System/Config/ConfigHandler.h"

CONFIG(int, NetworkLossFactor)
	.defaultValue(0)
	.minimumValue(0)
	.maximumValue(100);

CONFIG(int, InitialNetworkTimeout)
	.defaultValue(30)
	.minimumValue(10);

CONFIG(int, NetworkTimeout)
	.defaultValue(120)
	.minimumValue(0);

CONFIG(int, ReconnectTimeout)
	.defaultValue(15)
	.minimumValue(0);

CONFIG(int, MaximumTransmissionUnit)
	.defaultValue(1400)
	.minimumValue(400);

CONFIG(int, LinkOutgoingBandwidth)
	.defaultValue(64 * 1024)
	.minimumValue(0);

CONFIG(int, LinkIncomingSustainedBandwidth)
	.defaultValue(2 * 1024)
	.minimumValue(0);

CONFIG(int, LinkIncomingPeakBandwidth)
	.defaultValue(32 * 1024)
	.minimumValue(0);

CONFIG(int, LinkIncomingMaxPacketRate)
	.defaultValue(64)
	.minimumValue(0);

// maximum lag induced by command spam is:
// LinkIncomingMaxWaitingPackets / LinkIncomingMaxPacketRate = 8 seconds
CONFIG(int, LinkIncomingMaxWaitingPackets)
	.defaultValue(512)
	.minimumValue(0);

CONFIG(bool, UseNetMessageSmoothingBuffer).defaultValue(true);

CONFIG(bool, LuaWritableConfigFile).defaultValue(true);
CONFIG(bool, VFSCacheArchiveFiles).defaultValue(true);


void GlobalConfig::Init()
{
	// Recommended semantics for "expert" type config values:
	// <0 = disable (if applicable)
	networkLossFactor = configHandler->GetInt("NetworkLossFactor");
	initialNetworkTimeout = configHandler->GetInt("InitialNetworkTimeout");
	networkTimeout = configHandler->GetInt("NetworkTimeout");
	reconnectTimeout = configHandler->GetInt("ReconnectTimeout");
	mtu = configHandler->GetInt("MaximumTransmissionUnit");

	linkOutgoingBandwidth = configHandler->GetInt("LinkOutgoingBandwidth");
	linkIncomingSustainedBandwidth = configHandler->GetInt("LinkIncomingSustainedBandwidth");
	linkIncomingPeakBandwidth = configHandler->GetInt("LinkIncomingPeakBandwidth");
	linkIncomingMaxPacketRate = configHandler->GetInt("LinkIncomingMaxPacketRate");
	linkIncomingMaxWaitingPackets = configHandler->GetInt("LinkIncomingMaxWaitingPackets");

	if (linkIncomingSustainedBandwidth > 0 && linkIncomingPeakBandwidth < linkIncomingSustainedBandwidth)
		linkIncomingPeakBandwidth = linkIncomingSustainedBandwidth;
	if (linkIncomingPeakBandwidth > 0 && linkIncomingSustainedBandwidth <= 0)
		linkIncomingSustainedBandwidth = linkIncomingPeakBandwidth;
	if (linkIncomingMaxPacketRate > 0 && linkIncomingSustainedBandwidth <= 0)
		linkIncomingSustainedBandwidth = linkIncomingPeakBandwidth = 1024 * 1024;

	useNetMessageSmoothingBuffer = configHandler->GetBool("UseNetMessageSmoothingBuffer");
	luaWritableConfigFile = configHandler->GetBool("LuaWritableConfigFile");
	vfsCacheArchiveFiles = configHandler->GetBool("VFSCacheArchiveFiles");
}
#endif

GlobalConfig globalConfig;

