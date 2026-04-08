.PHONY: setup build build-release test test-cpp test-client test-all dev-client clean

# First-time setup
setup:
	cmake --preset debug
	cd client && npm install
	@echo ""
	@echo "Setup complete. Run 'make build' to build the server."
	@echo "Run 'make dev-client' to start the client dev server."

# Build
build:
	cmake --build build/debug

build-release:
	cmake --preset release
	cmake --build build/release

# Tests
test: build
	./build/debug/spring-tests

test-cpp: build
	./build/debug/spring-server

test-client:
	cd client && npx vitest run

test-all: test test-cpp test-client

# Development
dev-client:
	cd client && npm run dev

# Clean
clean:
	rm -rf build/
	cd client && rm -rf dist/ node_modules/.vite/
