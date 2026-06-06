#include "PlayerTeamEventCollector.h"

// Single process-wide collector. Pushed from the sim event sites
// (CTeam::Died, CPlayer::StartSpectating / JoinTeam) and from the
// disconnect handler in server_main; drained once per tick by the main loop.
PlayerTeamEventCollector playerTeamEvents;
