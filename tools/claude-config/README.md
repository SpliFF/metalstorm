# Claude Code Configuration

Reference configuration for developing Spring RTS Web with [Claude Code](https://claude.ai/code).

## Quick Setup

```bash
bash tools/claude-config/setup.sh
```

This copies the reference **permissions** template to `.claude/settings.json`
(won't overwrite an existing file) and installs the MCP server's dependencies.
It does not need to touch MCP server registration — that part is already
checked into the repo (see `.mcp.json` below) and works with no setup step.

## What's Included

### settings.json (permissions)

Auto-approves common development commands so Claude doesn't prompt for every build/test/git operation:

- Build: `cmake`, `make`, `ninja` targets
- Client: `npx tsc`, `npx vite`, `npm install`
- Tools: `springcli`, `curl`, `sqlite3`, `lsof`
- Git: `add`, `commit`, `push`, `status`, `stash`
- Process management: `pkill spring-*`

`.claude/settings.json` is gitignored (personal, per-checkout), so this file
is a template you opt into — edit your own copy freely without affecting
other developers.

### `.mcp.json` (repo root, tracked) — the real MCP config

This is the config Claude Code actually loads; nothing under `tools/claude-config/`
needs to be copied for MCP servers to work. It declares two servers:

- **`spring-debug`** — `node tools/debug-mcp/server.js`, talking to the log
  server (`:8010`) and lobby (`:8011`) over HTTP. **77 tools as of 2026-09-17**,
  spanning process/log introspection, game & sim control, unit/combat verbs,
  browser/client relay, scenario authoring, the world layer (`world_*`) and AI
  players (`ai_*`, `nl_command`). The tool *schemas* live in
  `tools/debug-mcp/tools.js` — that file, not `server.js`, is the source of
  truth (`server.js` just wires the transport), and it's what
  `tools/claude-config/check-skills.sh` diffs every skill/agent against. The
  full per-tool table is documented in `.claude/skills/spring-debug/SKILL.md`,
  not duplicated here.
- **`chrome-devtools`** — `npx chrome-devtools-mcp@latest --isolated`, for
  driving a real Chrome instance directly (see the `game-browser-test` skill).

### settings.local.json (template — usually unneeded)

This template pre-dates `.mcp.json` and duplicates its `spring-debug` entry
(without the `chrome-devtools` server). Since `.mcp.json` is tracked and
already registers `spring-debug` for everyone, you don't need to copy this
file at all in the common case. It's kept only for the one thing `.mcp.json`
can't give you per-checkout: pointing `spring-debug` at **non-default ports**.
If you do that, copy it to `.claude/settings.local.json` (which layers on top
of `.mcp.json`) and edit the `env` block there.

### The `taskherd` MCP server is not part of this repo's config

If you see a `taskherd` server available in a session, it comes from your
**user-level** `~/.claude.json`, not from anything under `.claude/` or
`.mcp.json` in this repo — `setup.sh` does not install or touch it, and there
is nothing to copy here. It's scoped to whichever machine has taskherd
installed, not to this checkout.

## Manual Setup

If you prefer not to run the setup script:

1. Create `.claude/` in the project root
2. Copy `settings.json` to `.claude/settings.json`
3. Run `npm install` in `tools/debug-mcp/`
4. (Optional, non-default ports only) copy `settings.local.json` to
   `.claude/settings.local.json` and edit its `env` block

## Customizing

- **Add permissions**: Edit `.claude/settings.json` to auto-approve additional commands
- **Change MCP server ports**: Copy `settings.local.json` to `.claude/settings.local.json` and edit its `env` block (see above)
- **Disable a repo-level MCP server**: not per-checkout — it's declared in the tracked `.mcp.json`

## `.claude/` and git

Most of `.claude/` is gitignored (`.claude/*` with `!.claude/skills/`), so
`.claude/settings.json` and `.claude/settings.local.json` are personal and
won't affect other developers. Two directories are the exception and ARE
tracked, shared, and reviewed like any other code:

- `.claude/skills/` — re-included directly in `.gitignore`
- `.claude/agents/` — force-added (`git add -f`) past the same ignore rule

Both are gated by `make check-skills` (`tools/claude-config/check-skills.sh`):
it harvests every MCP tool name + argument, HTTP route, SQL table/column, and
`window.test` method straight from the code and fails the build if a skill or
agent names something that doesn't exist. It's wired into `make test-debug-mcp`
as a prerequisite, so `make test-debug-mcp` runs it automatically; run it on
its own with `make check-skills`. It needs only node — no lobby, no game
server, no build — so it's safe and fast to run in a fresh worktree.
