
# Game sources — only files that exist after Phase 0 cleanup
make_global_var(sources_engine_Game
		"${CMAKE_CURRENT_SOURCE_DIR}/Action.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/ClientData.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/ClientSetup.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/GameData.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/GameHelper.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/GameSetup.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/GameVersion.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/GlobalUnsynced.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/Players/Player.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/Players/PlayerBase.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/Players/PlayerHandler.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/Players/PlayerStatistics.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/Players/TeamController.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/SyncedGameCommands.cpp"
		"${CMAKE_CURRENT_SOURCE_DIR}/WaitCommandsAI.cpp"
	)

