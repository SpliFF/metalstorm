# Browser Debug Console & Interactive Lua Debugging

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers the in-game browser debug console, the `Spring.*` Lua debug API, the interactive Lua debugger (breakpoints/stepping), and the Babylon.js scene inspector.

## Table of Contents

- [Browser Debug Console](#browser-debug-console)
  - [Opening the Console](#opening-the-console)
  - [Tabs](#tabs)
  - [Dock / Undock](#dock--undock)
  - [Log Viewer](#log-viewer)
  - [Command Input](#command-input)
  - [Programmatic API](#programmatic-api)
  - [Execution Scopes](#execution-scopes)
  - [Meta-Commands](#meta-commands)
  - [Server Commands](#server-commands)
  - [Network Inspector](#network-inspector)
- [Lua Debug API](#lua-debug-api)
  - [Spring.Debug](#springdebug)
  - [Spring.Warn](#springwarn)
  - [Spring.Assert](#springassert)
  - [Spring.DumpTable](#springdumptable)
  - [Spring.Inspect](#springinspect)
  - [Spring.Log](#springlog)
  - [Spring.Echo / Spring.Error](#springecho--springerror)
- [Interactive Lua Debugger](#interactive-lua-debugger)
  - [Setting Breakpoints](#setting-breakpoints)
  - [Stepping](#stepping)
  - [Stack and Variable Inspection](#stack-and-variable-inspection)
  - [Sim Pause Behavior](#sim-pause-behavior)
- [Babylon.js Inspector](#babylonjs-inspector)
- [Adding a Server Command](#adding-a-server-command)

---

## Browser Debug Console

A tabbed in-game overlay for log viewing and command execution. Each tab has independent scope, filters, history, and output. Tabs can be popped out to standalone windows.

### Opening the Console

- Press **backtick (`)** to toggle the console
- Or call `debugConsole.show()` from code / browser devtools

The console survives lobby restarts -- its log server connection is independent.

### Tabs

The tab bar shows all open console sessions. Each tab is an independent workspace:

- **Click** a tab label to switch to it
- **+** button creates a new tab (defaults to LuaRules scope)
- **x** closes a tab (closing the last tab hides the console)
- **arrow** button pops the tab out to its own browser window

Each tab maintains its own:
- Execution scope (LuaRules, server, sql, etc.)
- Log level/section/scope/search filters
- Command history (Up/Down arrows)
- Output buffer

### Dock / Undock

Click the arrow button on any tab to pop it out to a standalone window. The popout window contains the full panel (filters, output, command input) and works independently. Closing the popout window re-docks the tab back into the main console.

Use this to keep a Lua REPL open in one window while monitoring logs filtered to errors in another.

### Log Viewer

Each tab's output area displays log entries color-coded by level:

| Level | Color |
|-------|-------|
| DEBUG | grey |
| INFO | light grey |
| NOTICE | white |
| WARNING | yellow, tinted background |
| ERROR | red, tinted background |
| FATAL | bright red, bold |

**Filtering** (per tab, in the filter bar):

- **Level dropdown** -- minimum level (default: NOTICE)
- **Section** -- filter by section name (substring, case-insensitive)
- **Scope** -- filter by scope name (substring, case-insensitive)
- **Search** -- filter by message text (substring, case-insensitive)
- **Clear** -- clear the tab's output

Auto-scroll pauses when you scroll up and resumes when you scroll to the bottom.

### Command Input

The bottom bar has a scope selector, prompt, and a multi-line textarea.

- **Enter** -- execute the command
- **Shift+Enter** -- insert a newline (for multi-line Lua scripts)
- **Up/Down arrows** -- navigate command history (when input is empty)
- **Copy/paste** -- standard clipboard operations work in the textarea and output

Multi-line example:

```
LuaRules> local t = {}
          for i = 1, 5 do
            t[i] = i * i
          end
          return t
  {[1] = 1, [2] = 4, [3] = 9, [4] = 16, [5] = 25}
```

### Programmatic API

The debug console exposes a `debugConsole.exec()` method for automation. This is the preferred way for Claude (via chrome tools) and scripts to execute commands -- no DOM event simulation needed.

```javascript
// Available on window.debugConsole after init()

// Execute a command and get the result
const result = await debugConsole.exec('server', 'frame');
// result = { success: true, output: "1234" }

// Lua execution
const r = await debugConsole.exec('LuaRules', 'return Spring.GetAllUnits()');
// r = { success: true, output: "{1, 2, 3}" }

// Multi-line Lua
const r2 = await debugConsole.exec('LuaRules', `
local t = {}
for i = 1, 5 do t[i] = i * i end
return t
`);
// r2 = { success: true, output: "{[1] = 1, [2] = 4, ...}" }

// Error handling
const r3 = await debugConsole.exec('LuaRules', 'bad syntax');
// r3 = { success: false, output: "syntax error: ..." }
```

The `exec()` method sends a `ConsoleCommand` FlatBuffer to the game server and returns a Promise that resolves when the `ConsoleResponse` arrives (10s timeout).

### Execution Scopes

| Scope | Target | What it runs |
|-------|--------|-------------|
| `LuaRules` | Game server | Lua code in the LuaRules synced state |
| `LuaGaia` | Game server | Lua code in the LuaGaia synced state |
| `server` | Game server | Built-in server commands (see below) |
| `lobby` | Lobby server | Built-in lobby commands |
| `sql` | Lobby server | Read-only SQL against the game database |

Switch scopes with the dropdown or the `/connect` meta-command.

### Meta-Commands

These work in all scopes and start with `/`:

| Command | Description |
|---------|-------------|
| `/connect <scope>` | Switch execution scope |
| `/scopes` | List available scopes |
| `/clear` | Clear the tab's output |
| `/inspector` | Toggle Babylon.js scene inspector |
| `/help` | Show all commands and shortcuts |

### Server Commands

Available when scope is `server`:

| Command | Output |
|---------|--------|
| `frame` | Current simulation frame number |
| `state` | `frame=N teams=N units=N` |
| `units` | List all units (max 100) with id, def, team, health |
| `units <teamId>` | List units for a specific team |
| `defs` | Count of loaded unit and weapon definitions |
| `pause` | Pause the simulation |
| `unpause` | Resume the simulation |
| `speed <multiplier>` | Set game speed (0-100) |
| `break <file>:<line>` | Set a Lua breakpoint |
| `break list` | List all breakpoints |
| `break clear` | Remove all breakpoints |
| `continue` / `c` | Resume from breakpoint |
| `step` / `s` | Step one Lua line |
| `step_over` / `n` | Step over (stay at current call depth) |
| `step_out` / `o` | Step out (return to caller) |

**Lobby scope commands:**

| Command | Output |
|---------|--------|
| `rooms` | List all active rooms |
| `process list` | List game server processes (pid, port) |

### Network Inspector

Toggle the **Net** checkbox in the console header to enable the network message inspector. When enabled, all inbound and outbound game-connection messages (WebRTC data channels today; → WebTransport, PLAN-game-worker.md) are decoded and logged:

```
[INFO] [client:net] <- [FlatBuffers] AuthResponse (128 bytes)
[INFO] [client:net] -> [FlatBuffers] ViewportUpdate (64 bytes)
[INFO] [client:net] <- [EntityState] (2048 bytes)
```

The inspector decodes the envelope byte (FlatBuffers, EntityState, EntityDelta, ProjectileState) and, for FlatBuffers messages, extracts the payload type name (AuthResponse, MapData, PlayerCommand, etc.). The same decoded-message accounting backs `window.test.netStats()` — see [debugging-performance.md](debugging-performance.md#network-simulator--wan-conditions-on-localhost).

---

## Lua Debug API

These functions are available in all synced Lua contexts (LuaRules, LuaGaia). They route through the unified logging system with the calling handle's name as the scope.

### Spring.Debug

```lua
Spring.Debug(arg1, arg2, ...)
```

Log at **DEBUG** level. Arguments are converted to strings via `tostring()` and joined with tabs. Useful for verbose diagnostic output that should be hidden by default.

### Spring.Warn

```lua
Spring.Warn(arg1, arg2, ...)
```

Log at **WARNING** level. Same argument handling as `Debug`. Use for recoverable issues that should be visible during development.

### Spring.Assert

```lua
Spring.Assert(condition, message)
```

If `condition` is falsy, logs at **ERROR** level with an "ASSERT:" prefix and raises a Lua error (halts the current callin). If `condition` is truthy, does nothing.

```lua
local unit = Spring.GetUnitByID(unitId)
Spring.Assert(unit, "unit " .. unitId .. " not found")
-- if unit is nil, this logs "ASSERT: unit 42 not found" and errors
```

### Spring.DumpTable

```lua
Spring.DumpTable(table, label, maxDepth)
```

Pretty-print a table to the log at **NOTICE** level with recursive indentation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | table | required | The table to dump |
| `label` | string | `"table"` | Label shown before the dump |
| `maxDepth` | integer | 3 | Maximum nesting depth (deeper shows `{...}`) |

```lua
Spring.DumpTable(UnitDefs[1], "tank_def", 2)
-- Logs:
-- [lua:LuaRules] tank_def = {
--   ["name"] = "tank",
--   ["maxHealth"] = 1000,
--   ["weapons"] = {
--     [1] = {...},
--   },
-- }
```

Tables with more than 100 entries are truncated with `...`.

### Spring.Inspect

```lua
Spring.Inspect(name1, value1, name2, value2, ...)
```

Log name-value pairs at **NOTICE** level. Tables are auto-expanded to depth 2. Intended for quick variable inspection during development.

```lua
local hp = Spring.GetUnitHealth(unitId)
local pos = {Spring.GetUnitPosition(unitId)}
Spring.Inspect("hp", hp, "pos", pos)
-- Logs:
-- [lua:LuaRules] hp = 850
-- pos = {[1] = 1024.5, [2] = 100.0, [3] = 512.3}
```

### Spring.Log

```lua
Spring.Log(section, level, arg1, arg2, ...)
```

Log with an explicit section and level. The `level` parameter accepts numeric LOG constants (10=debug, 20=info, 30=notice, 40=warning, 50=error, 60=fatal) or string names (`"debug"`, `"info"`, `"notice"`, `"warning"`, `"error"`, `"fatal"`).

```lua
Spring.Log("my_gadget", "warning", "resource pool low:", amount)
```

### Spring.Echo / Spring.Error

```lua
Spring.Echo(arg1, arg2, ...)    -- logs at NOTICE level
Spring.Error(message)            -- raises a Lua error (like error())
```

`Spring.Echo` routes through springlog at NOTICE level. `Spring.Error` calls `luaL_error()` which raises a Lua exception (caught by the callin error handler in LuaHandle.cpp, which logs the traceback).

---

## Interactive Lua Debugger

The debugger lets you set breakpoints in server-side Lua code, pause the simulation, and inspect the call stack and variables.

### Setting Breakpoints

From the debug console (scope `server`):

```
server> break LuaRules/Gadgets/unit_spawner.lua:42
  breakpoint 1 set

server> break list
  #1 LuaRules/Gadgets/unit_spawner.lua:42

server> break clear
  all breakpoints cleared
```

Breakpoint file matching is substring-based -- `unit_spawner.lua:42` will match any source file whose path contains `unit_spawner.lua`.

From Lua code:

```lua
Spring.Breakpoint("checking spawn logic")
-- logs: "BREAKPOINT hit: checking spawn logic"
-- (actual pause not yet wired from Lua side)
```

### Stepping

When paused at a breakpoint, use these commands:

| Command | Shortcut | Behavior |
|---------|----------|----------|
| `continue` | `c` | Resume execution |
| `step` | `s` | Execute one line, then pause |
| `step_over` | `n` | Execute until returning to the same call depth |
| `step_out` | `o` | Execute until the current function returns |

### Stack and Variable Inspection

The debugger provides these inspection functions (callable from `LuaExecEngine` when paused):

- **Call stack** -- file, line, function name, type (Lua/C/main) for each frame (up to 50 levels)
- **Locals** -- name, type, and string value of all local variables in a given frame (up to 100 variables)
- **Upvalues** -- captured variables from enclosing scopes
- **Eval** -- evaluate an expression in the paused context

These are accessible programmatically via the `LuaDebugger` C++ API but are not yet wired to console commands.

### Sim Pause Behavior

When a breakpoint fires, the debugger sets a `paused` flag. The main simulation loop checks this flag each tick:

```cpp
if (sim.HasGameStarted() && !g_luaDebugger.IsPaused()) {
    sim.SimFrame();
}
```

While paused, the server still processes inbound network messages (including console commands) but does not advance the simulation. This means the entire game halts -- all players see a frozen game state until the breakpoint is continued.

The debug hook is installed with `LUA_MASKLINE`, which fires on every Lua line. This has a performance cost -- only attach the hook when actively debugging.

---

## Babylon.js Inspector

The Babylon.js built-in inspector shows the scene graph, materials, textures, performance counters, and allows live material editing.

**Toggle:**

- Press **F12** (when the game is running)
- Or type `/inspector` in the debug console

The inspector renders as an embedded panel alongside the game canvas. Call `debugConsole.setScene(scene)` from `main.ts` after creating the Babylon.js scene to enable this integration.

For frame-time and per-widget cost breakdowns (rather than the Babylon inspector's live scene-graph view), see [debugging-performance.md](debugging-performance.md).

---

## Adding a Server Command

Add a new case in `ExecuteServerCommand()` in `rts/Server/LuaExecEngine.cpp`:

```cpp
if (cmd == "my_command") {
    // Access any sim state via global objects
    return "result string";
}
```

The result is sent back to the caller as a `ConsoleResponse` FlatBuffer message. Return a string starting with `"unknown command:"` to signal failure.
