#!/bin/bash
# Setup Claude Code configuration for Spring RTS Web development.
#
# Copies the reference permissions template to .claude/ and installs the
# spring-debug MCP server's dependencies. Run from the project root:
#
#   bash tools/claude-config/setup.sh
#
# MCP server registration itself needs no setup step: the repo-root
# .mcp.json (tracked in git) already declares spring-debug and
# chrome-devtools for every checkout. This script does NOT copy
# settings.local.json — that template only exists for the one thing
# .mcp.json can't do (pointing spring-debug at non-default ports); copy
# it by hand if you need that (see tools/claude-config/README.md).
#
# The `taskherd` MCP server (if you see one) is unrelated to this repo:
# it comes from the user-level ~/.claude.json on machines that have
# taskherd installed, not from anything here.

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

# Install MCP server dependencies
if [ -f "$PROJECT_ROOT/tools/debug-mcp/package.json" ]; then
    echo
    echo "Installing spring-debug MCP server dependencies..."
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
echo "  - spring-debug MCP server deps installed (server itself is already"
echo "    registered for every checkout via the tracked .mcp.json)"
echo
echo "To start the dev environment: mprocs"
echo "To build: make build"
echo "To check the skills/agents tree against the code: make check-skills"
