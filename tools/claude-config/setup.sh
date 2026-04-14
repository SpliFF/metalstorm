#!/bin/bash
# Setup Claude Code configuration for Spring RTS Web development.
#
# Copies reference settings to .claude/ and installs the MCP server
# dependencies. Run from the project root:
#
#   bash tools/claude-config/setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "Spring RTS Web — Claude Code setup"
echo "===================================="
echo "Project: $PROJECT_ROOT"
echo

# Create .claude directory
mkdir -p "$PROJECT_ROOT/.claude"

# Copy settings (don't overwrite existing)
if [ ! -f "$PROJECT_ROOT/.claude/settings.json" ]; then
    cp "$SCRIPT_DIR/settings.json" "$PROJECT_ROOT/.claude/settings.json"
    echo "Created .claude/settings.json (permissions)"
else
    echo "Skipped .claude/settings.json (already exists)"
fi

if [ ! -f "$PROJECT_ROOT/.claude/settings.local.json" ]; then
    cp "$SCRIPT_DIR/settings.local.json" "$PROJECT_ROOT/.claude/settings.local.json"
    echo "Created .claude/settings.local.json (MCP server config)"
else
    echo "Skipped .claude/settings.local.json (already exists)"
fi

# Install MCP server dependencies
if [ -f "$PROJECT_ROOT/tools/debug-mcp/package.json" ]; then
    echo
    echo "Installing MCP server dependencies..."
    cd "$PROJECT_ROOT/tools/debug-mcp"
    npm install --silent 2>/dev/null || echo "  (npm install failed — MCP tools may not work)"
    echo "Done."
fi

echo
echo "Setup complete. Claude Code will pick up the settings on next start."
echo
echo "What was configured:"
echo "  - Build commands (cmake, make) auto-approved"
echo "  - springcli auto-approved"
echo "  - Git operations auto-approved"
echo "  - curl, sqlite3, process management auto-approved"
echo "  - MCP server: spring-debug (log queries, exec, game state)"
echo
echo "To start the dev environment: mprocs"
echo "To build: make build"
