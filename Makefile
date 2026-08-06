.PHONY: setup build build-release test test-cpp test-client test-all dev-client generate-protocol export-metalstorm-specs clean test-headless-batch test-headless-determinism test-replay-verify

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
# checks, the replay-verdict parser (PLAN-replay.md task 5) and the soak
# growth-slope ruling (PLAN-long-uptime.md task 4).
test-headless-batch:
	cd tools/headless-batch && node --test test/matrix.test.mjs test/fixture-checks.test.mjs test/replay-verdict.test.mjs test/growth-fit.test.mjs

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

# Soak ladder + growth report (PLAN-long-uptime.md task 4). NOT part of
# test-all: four arms of one simulated day each cost ~35 wall-minutes. Uses the
# RELEASE binary deliberately — the debug build ticks this content ~30x slower,
# which is the difference between a simulated day costing 11 minutes and costing
# 5 hours. Gate is `growth-report`'s exit code: an unexplained positive slope on
# a container PLAN-long-uptime §1 claims is bounded fails the run.
#   SOAK_WALL_MIN=n  per-arm wall ceiling (each arm stops early, dump is still written)
#   SOAK_OUT=dir     output directory
SOAK_OUT ?= build/soak
SOAK_WALL_MIN ?= 45
soak-growth:
	cmake --build build/release --target spring-server
	node tools/headless-batch/batch.mjs \
		--template tools/headless-batch/fixtures/soak-ladder.json \
		--matrix tools/headless-batch/fixtures/soak-matrix.json \
		--out-dir $(SOAK_OUT) --server-bin build/release/spring-server \
		--concurrency 4 --max-wall-min $(SOAK_WALL_MIN) --base-port 19200
	node tools/headless-batch/growth-report.mjs \
		--jsonl $(SOAK_OUT)/results.jsonl \
		--budgets tools/headless-batch/fixtures/soak-budgets.json \
		--json $(SOAK_OUT)/growth-report.json

# Development
dev-client:
	cd client && npm run dev

# Clean
clean:
	rm -rf build/
	cd client && rm -rf dist/ node_modules/.vite/
