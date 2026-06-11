.PHONY: setup build build-release test test-cpp test-client test-all dev-client generate-protocol clean

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
build:
	cmake --build build/debug

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

# Development
dev-client:
	cd client && npm run dev

# Clean
clean:
	rm -rf build/
	cd client && rm -rf dist/ node_modules/.vite/
