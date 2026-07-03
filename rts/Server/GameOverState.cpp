#include "GameOverState.h"

// The single game-over relay instance. Declared by LuaSyncedCtrl::GameOver
// (Spring.GameOver) or StateStreamer's last-team-standing fallback; drained by
// StateStreamer::Tick. See GameOverState.h.
GameOverRelay gameOverRelay;
