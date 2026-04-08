# PLAN: Scripting Abstraction Layer

## Problem Statement

The Spring RTS Web engine currently has ~64 files in `rts/Lua/` that tightly couple the C++ simulation to Lua 5.1 via `CLuaHandle` (which extends `CEventClient` and directly manages a `lua_State*`). The planned Lua 5.4 upgrade for the server, combined with the need to support server-side AI in Lua thread pools and potential future scripting languages, demands a clean abstraction boundary between the engine's event system and any script interpreter.

## Current Architecture

The coupling chain is:

1. **CEventClient** (`rts/System/EventClient.h`) -- abstract base with ~90 virtual call-in methods plus a permission model (`GetReadAllyTeam`, `GetFullRead`, `CanReadAllyTeam`)
2. **CEventHandler** (`rts/System/EventHandler.h`) -- singleton dispatcher that iterates `EventClientList` vectors per event, applying ally-team visibility filtering inline via macros
3. **CLuaHandle** (`rts/Lua/LuaHandle.h`) -- extends `CEventClient`, owns a `lua_State*`, implements every call-in by pushing a Lua function + args and calling `RunCallIn`
4. **luaContextData** (`rts/Lua/LuaContextData.h`) -- per-handle struct carrying `synced`, `fullCtrl`, `fullRead`, `ctrlTeam`, `readTeam`, `readAllyTeam`, plus memory pool and GC state
5. **CSyncedLuaHandle / CUnsyncedLuaHandle** (`rts/Lua/LuaHandleSynced.h`) -- split handles; synced side implements `Allow*` and `*PreDamaged` control events
6. **CLuaRules / CLuaGaia** -- concrete handles
7. **LuaSyncedRead / LuaSyncedCtrl** -- static classes registering ~200+ C functions into Lua's global namespace

## Design Goals

1. **Decouple event dispatch from script interpreter** -- the engine emits typed events; interpreters consume them
2. **Language-agnostic API surface** -- Read and Ctrl functions are declared once, bound per-interpreter
3. **Preserve synced/unsynced distinction** -- synced scripts run on sim thread and can return values that alter simulation
4. **Preserve permission model** -- each script context carries its access permissions
5. **Thread-safe for AI pool** -- AI Lua VMs run on worker threads with read-only snapshots
6. **Lua 5.4 swap is contained** -- only the Lua-specific adapter layer touches lua.h

## Abstraction Layer Design

### Layer 1: ScriptPermissions (value type)

Replace the scattered permission fields from `luaContextData` with a standalone struct:

```cpp
struct ScriptPermissions {
    bool synced;
    bool fullCtrl;
    bool fullRead;
    int  ctrlTeam;    // NoAccessTeam = -1, AllAccessTeam = -2
    int  readTeam;
    int  readAllyTeam;
    int  selectTeam;
};
```

Plain-old-data struct with no Lua dependency. Moves out of `luaContextData` into `rts/System/ScriptPermissions.h`.

### Layer 2: ScriptEvent (typed event payload)

A thin event envelope that carries entity IDs and scalar data instead of raw C++ pointers:

```cpp
struct ScriptEvent {
    enum Type : uint16_t { ... };  // One per Events.def entry
    Type type;
    // Union or variant of typed payloads
};
```

For synced `Allow*` and `*PreDamaged` events that return values, the payload includes an output pointer/reference. These events remain synchronous.

Entity IDs instead of pointers ensures thread safety for AI (worker threads must not dereference sim pointers).

### Layer 3: IScriptContext (replaces CEventClient for scripts)

```cpp
class IScriptContext {
public:
    virtual ~IScriptContext() = default;
    virtual const std::string& GetName() const = 0;
    virtual int GetOrder() const = 0;
    virtual const ScriptPermissions& GetPermissions() const = 0;
    virtual bool WantsEvent(ScriptEvent::Type type) const = 0;
    virtual void HandleEvent(const ScriptEvent& event) = 0;
    virtual bool HandleControlEvent(ScriptEvent& event) = 0;
    virtual bool Init(const std::string& code, const std::string& source) = 0;
    virtual void Shutdown() = 0;
    virtual void CollectGarbage(bool forced) = 0;
};
```

Zero Lua dependency. Any scripting language implements this.

### Layer 4: ScriptEventDispatcher

A single `CEventClient` that bridges from `CEventHandler` (raw C++ pointers) to `IScriptContext` instances (entity IDs):

```cpp
class ScriptEventDispatcher : public CEventClient {
public:
    void AddContext(IScriptContext* ctx);
    void RemoveContext(IScriptContext* ctx);
    // CEventClient overrides -- translate C++ args to ScriptEvent
    void UnitCreated(const CUnit* unit, const CUnit* builder) override;
    bool AllowCommand(...) override;
    // ... all ~90 events
};
```

This preserves the existing `CEventHandler` machinery while isolating all script interpreters behind the new interface.

### Layer 5: IScriptAPI (read/ctrl function registry)

```cpp
class IScriptAPI {
public:
    virtual void RegisterReadFunctions(IScriptContext& ctx) = 0;
    virtual void RegisterCtrlFunctions(IScriptContext& ctx) = 0;
};
```

The actual implementation for Lua 5.4 (`LuaScriptAPI`) calls `lua_register` etc. Function bodies in `LuaSyncedRead.cpp` and `LuaSyncedCtrl.cpp` are refactored to extract core logic into language-neutral `ScriptReadAPI` / `ScriptCtrlAPI` functions.

### Layer 6: LuaScriptContext (Lua 5.4 implementation)

Refactored from `CLuaHandle`. Owns a `lua_State*`, implements `HandleEvent` by marshalling `ScriptEvent` payloads to Lua stack values.

## Event Classification

| Category | Examples | Count | Behaviour |
|----------|---------|-------|-----------|
| Notification | GameFrame, UnitCreated, UnitDamaged | ~60 | Dispatched to all matching contexts, void return |
| Control | AllowCommand, UnitPreDamaged, CommandFallback | ~25 | Synchronous, first non-default return wins, sim-thread only |
| Unsynced/rendering | DrawScreen, KeyPress, MouseMove | ~30 | Irrelevant for server; handled by client widget system |

## Thread Safety Model

| Context | Thread | Sim Access | Event Delivery |
|---------|--------|------------|----------------|
| LuaRules (synced) | Sim thread | Direct (ID lookup) | Synchronous |
| LuaGaia (synced) | Sim thread | Direct | Synchronous |
| AI Lua VM | Worker thread | Read-only snapshot | Async via MPSC queue |
| Client Lua WASM | Browser thread | Network state | N/A (separate system) |

## API Surface Refactoring

The ~320 functions in `LuaSyncedRead.cpp` and `LuaSyncedCtrl.cpp` are split into:
1. **Core logic** (`ScriptReadAPI.h/.cpp`, `ScriptCtrlAPI.h/.cpp`) -- takes entity IDs, returns C++ types
2. **Lua binding** (existing files become thin wrappers) -- pops/pushes Lua stack values

This means a future Python/JS interpreter only writes the marshalling layer, not the game state queries.

Start with the ~50 most-used functions; extract the rest incrementally.

## File Organization

New files:
```
rts/System/Scripting/
    ScriptPermissions.h
    ScriptEvent.h
    IScriptContext.h
    ScriptEventDispatcher.h/.cpp
    ScriptReadAPI.h/.cpp
    ScriptCtrlAPI.h/.cpp
```

Modified files:
```
rts/Lua/LuaHandle.h/.cpp         -- refactored to LuaScriptContext
rts/Lua/LuaRules.h/.cpp          -- creates LuaScriptContext
rts/Lua/LuaGaia.h/.cpp           -- creates LuaScriptContext
rts/Lua/LuaSyncedRead.cpp        -- thin wrappers around ScriptReadAPI
rts/Lua/LuaSyncedCtrl.cpp        -- thin wrappers around ScriptCtrlAPI
rts/Lua/LuaContextData.h         -- permissions extracted
```

## Implementation Sequence

1. **ScriptPermissions + ScriptEvent** -- define the types
2. **IScriptContext + ScriptEventDispatcher** -- build the dispatcher, register as CEventClient
3. **LuaScriptContext wrapping CLuaHandle** -- wrap existing Lua handling, verify identical behavior
4. **CLuaRules/CLuaGaia migration** -- switch to LuaScriptContexts
5. **ScriptReadAPI/ScriptCtrlAPI extraction** -- ongoing, start with top 50 functions
6. **Lua 5.4 swap** -- update lib/lua, fix API differences (can also be done earlier)
7. **AILuaScriptContext** -- thread-safe variant for AI pool

The Lua 5.4 swap (step 6) can be done independently at any point since it only touches `rts/lib/lua/` and the Lua binding code. The abstraction layer makes it cleaner but isn't a prerequisite.

## Risks

**Performance:** One extra virtual call per event plus `ScriptEvent` construction. Negligible for ~30 events per frame.

**Allow* synchronous return:** Control events include output pointers, dispatched synchronously on sim thread. No async path.

**Lua 5.4 script breakage:** `compat-5.1.lua` shim handles common differences. Not a concern per CLAUDE.md -- no backwards compatibility needed.

**Large diff for ScriptReadAPI extraction:** Do incrementally. Lua wrappers initially just call through to same static methods.
