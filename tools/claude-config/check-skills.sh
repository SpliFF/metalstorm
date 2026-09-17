#!/usr/bin/env bash
# check-skills.sh — does the skill tree still describe the code that exists?
#
# Runs the name-level drift check over .claude/skills/**/*.md and
# .claude/agents/*.md: every MCP tool, tool argument, exec verb, HTTP route,
# window.test method and relative file path a skill names must be findable in
# the code. See check-skills.mjs for what each rule resolves against and why.
#
#   tools/claude-config/check-skills.sh        # exit 0 clean, 1 with findings
#
# Needs node (v22, the same one .mcp.json runs the MCP under) and nothing else:
# no lobby, no game server, no build. It is safe in a fresh worktree.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-skills.mjs" "$@"
