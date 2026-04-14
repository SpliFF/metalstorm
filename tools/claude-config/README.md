# Claude Code Configuration

Reference configuration for developing Spring RTS Web with [Claude Code](https://claude.ai/code).

## Quick Setup

```bash
bash tools/claude-config/setup.sh
```

This copies the reference settings to `.claude/` (won't overwrite existing files) and installs MCP server dependencies.

## What's Included

### settings.json (permissions)

Auto-approves common development commands so Claude doesn't prompt for every build/test/git operation:

- Build: `cmake`, `make`, `ninja` targets
- Client: `npx tsc`, `npx vite`, `npm install`
- Tools: `springcli`, `curl`, `sqlite3`, `lsof`
- Git: `add`, `commit`, `push`, `status`, `stash`
- Process management: `pkill spring-*`

### settings.local.json (MCP server)

Configures the `spring-debug` MCP server which gives Claude access to:

| Tool | Description |
|------|-------------|
| `get_logs` | Query log server for recent entries |
| `search_logs` | Full-text log search |
| `exec_lua` | Execute Lua/server commands on the game server |
| `list_processes` | List game server processes |
| `get_lua_source` | Read Lua source files |
| `query_db` | SQL queries against the game database |
| `list_sessions` | Game session history |

The MCP server connects to `http://localhost:8010` (log server) and `http://localhost:8011` (lobby) by default. Change these in `settings.local.json` if your ports differ.

## Manual Setup

If you prefer not to run the setup script:

1. Create `.claude/` in the project root
2. Copy `settings.json` to `.claude/settings.json`
3. Copy `settings.local.json` to `.claude/settings.local.json`
4. Run `npm install` in `tools/debug-mcp/`

## Customizing

- **Add permissions**: Edit `.claude/settings.json` to auto-approve additional commands
- **Change ports**: Edit the `env` section in `.claude/settings.local.json`
- **Disable MCP**: Remove the `mcpServers` section from `.claude/settings.local.json`

The `.claude/` directory is gitignored — your local changes won't affect other developers.
