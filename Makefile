.PHONY: setup build build-release test test-cpp test-client test-all dev-client generate-protocol export-metalstorm-specs clean test-headless-batch test-headless-determinism test-replay-verify test-replay-spectate soak-growth soak-churn

# First-time setup
setup:
	cmake --preset debug
	cd client && npm install
	$(MAKE) generate-protocol
	mkdir -p data
	@echo ""
	@echo "Setup complete. Run 'make build' to build the server."
	@echo "Run 'make dev-client' to start the client dev server."

# Build
build: export-metalstorm-specs
	cmake --build build/debug

# Export Metalstorm's shared Lua spec files (e.g. authority_cost.lua, the
# order-cost formula spec — PLAN-metalstorm-authority.md task 5/A3) to JSON
# for the client mirror. Output lands in data/games/metalstorm/, served
# as-is by the static-data pipeline (see tools/scripts/lua-to-json.lua).
export-metalstorm-specs:
	lua tools/scripts/lua-to-json.lua \
		data/games/metalstorm/LuaRules/Configs/authority_cost.lua \
		data/games/metalstorm/authority_cost.json

# Generate FlatBuffers bindings for both C++ and TypeScript
generate-protocol: build
	mkdir -p client/src/protocol
	build/debug/_deps/flatbuffers-build/flatc --ts --gen-object-api -o client/src/protocol/ schemas/protocol.fbs

build-release:
	cmake --preset release
	cmake --build build/release

# Tests
# Build only the test target (not the whole game server) and run it via CTest
# so `ctest`, the testPresets, and `make test-cpp` all exercise the same path.
test-cpp:
	cmake --build build/debug --target spring-tests
	ctest --test-dir build/debug --output-on-failure

# Back-compat alias for the C++ suite.
test: test-cpp

test-client:
	cd client && npx vitest run

test-all: test-cpp test-client

# headless-batch pure unit tests (no server build needed): matrix expansion
# (PLAN-headless.md task 3 §6 "meta" requirement), the fixture non-vacuity
# checks, the replay-verdict parser and the spectate-arm rules (PLAN-replay.md
# task 5 / §7.11 T2-a-1), the soak growth-slope ruling (PLAN-long-uptime.md
# task 4) and the churn-arm verdict (PLAN-long-uptime.md T4-1).
test-headless-batch:
	cd tools/headless-batch && node --test test/matrix.test.mjs test/fixture-checks.test.mjs test/replay-verdict.test.mjs test/replay-spectate.test.mjs test/growth-fit.test.mjs test/run-paths.test.mjs test/churn-checks.test.mjs

# Determinism pair-run CI hook (PLAN-headless.md task 4): builds spring-server,
# runs the PaperTanks-scale fixture twice, diffs the two stateHash sequences.
test-headless-determinism:
	cmake --build build/debug --target spring-server
	node tools/headless-batch/determinism-pair-run.mjs \
		--server-bin build/debug/spring-server \
		--out-dir build/headless-determinism

# Fixture-replay verify (PLAN-replay.md task 5): record the same fixture to a
# replay file, then re-execute the recorded cause stream and assert it
# reproduces its own embedded state-hash track — including through the .msr
# export packer. Gates on the `replay verify:` log line, never the exit code
# (T2-b: spring-server aborts during static destruction after main returns).
test-replay-verify:
	cmake --build build/debug --target spring-server
	node tools/headless-batch/replay-verify-run.mjs \
		--server-bin build/debug/spring-server \
		--out-dir build/replay-verify \
		--pack

# Replay SPECTATE gate (PLAN-replay.md §7.11 T2-a-1): the same recording
# re-executed twice — once with a real client attached over the real wire as a
# spectator, once with nobody watching — and both arms must reproduce the hash
# track identically. This is the only gate that exercises the live
# Handshake/AuthRequest admission path on a replay server (a headless run has no
# clients) and the only one that can observe the sim-affecting-verb refusal,
# which `--verify` cannot see: on 2026-08-14 that gate was inert and the hash
# track still passed 30/30. Needs client/'s WebTransport addon (`npm install`).
test-replay-spectate:
	cmake --build build/debug --target spring-server
	node tools/headless-batch/replay-spectate-run.mjs \
		--server-bin build/debug/spring-server \
		--out-dir build/replay-spectate

# Soak ladder + growth report (PLAN-long-uptime.md task 4). NOT part of
# test-all: four arms of one simulated day each cost ~35 wall-minutes. Uses the
# RELEASE binary deliberately — the debug build ticks this content ~30x slower,
# which is the difference between a simulated day costing 11 minutes and costing
# 5 hours. Gate is `growth-report`'s exit code: an unexplained positive slope on
# a container PLAN-long-uptime §1 claims is bounded fails the run.
#   SOAK_WALL_MIN=n  per-arm wall ceiling (each arm stops early, dump is still written)
#   SOAK_OUT=dir     output directory
#   SOAK_CONCURRENCY=n  arms in flight. Lower it on a contended machine: an arm's
#     coverage is measured in SIMULATED days, so anything that slows the tick
#     shortens the fitted span and pushes metrics to `too-short` (PLAN-long-uptime
#     §11.2 — the one arm that ruled anything was the one run alone).
SOAK_OUT ?= build/soak
SOAK_WALL_MIN ?= 45
SOAK_CONCURRENCY ?= 4
soak-growth:
	cmake --build build/release --target spring-server
	node tools/headless-batch/batch.mjs \
		--template tools/headless-batch/fixtures/soak-ladder.json \
		--matrix tools/headless-batch/fixtures/soak-matrix.json \
		--out-dir $(SOAK_OUT) --server-bin build/release/spring-server \
		--concurrency $(SOAK_CONCURRENCY) --max-wall-min $(SOAK_WALL_MIN) --base-port 19200
	node tools/headless-batch/growth-report.mjs \
		--jsonl $(SOAK_OUT)/results.jsonl \
		--budgets tools/headless-batch/fixtures/soak-budgets.json \
		--json $(SOAK_OUT)/growth-report.json

# Churn arm — "ladder 2" (PLAN-long-uptime.md T4-1). Two arms of the SAME
# fixture: one with N scripted wire sessions connecting / ordering /
# disconnecting for the window, one with nobody connecting. It is the only
# ladder that can rule S1 (`param_keys`) or S6 (`standing_orders`) at all —
# both read 0 at every sample of every client-less soak, because the streamer
# skips interning at zero clients and a standing order is refused without a
# seat. NOT part of test-all: two wall-window arms, and it needs client/'s
# WebTransport addon (`npm install`).
#   CHURN_WINDOW_MIN=n  per-arm wall window (default 3)
#   CHURN_SESSIONS=n    concurrent churn accounts (default 2)
CHURN_OUT ?= build/soak-churn
CHURN_WINDOW_MIN ?= 3
CHURN_SESSIONS ?= 2
soak-churn:
	cmake --build build/release --target spring-server
	node tools/headless-batch/soak-churn-run.mjs \
		--server-bin build/release/spring-server \
		--out-dir $(CHURN_OUT) --window-min $(CHURN_WINDOW_MIN) \
		--sessions $(CHURN_SESSIONS)

# Development
dev-client:
	cd client && npm run dev

# Clean
clean:
	rm -rf build/
	cd client && rm -rf dist/ node_modules/.vite/
