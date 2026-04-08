# PLAN: UI Architecture

## Overview

Game UI is HTML/CSS/JS layered over the WebGL canvas. Spring's original Lua-based UI system (chili, TweakUI, gl.* drawing) is not carried forward. Games build their UI in HTML/JS, which is the natural choice for a browser-first engine.

The WebGL canvas handles only map terrain, units, projectiles, and visual effects. Everything else — HUD, minimap, menus, chat, tooltips, command panels — is HTML.

## HTML over WebGL

### Why this works

The browser compositor natively handles layer composition. An HTML div at `z-index: 10` renders above a canvas at `z-index: 0` with zero performance penalty. The canvas renders at full resolution underneath. This is how every major browser game engine works (Phaser, PlayCanvas, Unity WebGL, Godot Web).

### Performance considerations

- **No penalty** for overlapping HTML on WebGL. The GPU composites layers; HTML elements don't cause canvas redraws.
- **Avoid excessive DOM updates** during gameplay. Batch HUD updates to once per frame, not per entity.
- **CSS transforms** for animations (e.g. health bars) are GPU-accelerated and don't trigger layout.
- **Canvas-based minimap** inside an HTML container is fine — it's a separate 2D canvas, composited the same way.
- **Avoid `opacity` animations** on large elements — use `visibility` toggle instead.

### No element loss

HTML elements do not "disappear behind" a fullscreen WebGL canvas. CSS `z-index` and stacking contexts are absolute. The canvas is just another element in the DOM — it does not steal focus or eat events unless explicitly configured to.

## Mouse Input Architecture

### Layer priority

```
Click event
  ↓
  Does it hit an HTML element with pointer-events: auto?
  ├─ YES → HTML element handles it (button click, text input, etc.)
  └─ NO  → Falls through to the canvas
             ↓
             Babylon.js scene.onPointerObservable handles it
             ├─ Hit an entity? → Select it
             └─ Hit ground?   → Issue move/attack command
```

### Implementation

```css
/* Game HUD container — transparent to clicks except on buttons */
#game-hud {
    position: fixed;
    inset: 0;
    z-index: 10;
    pointer-events: none;  /* clicks fall through */
}

/* Interactive elements within the HUD */
#game-hud .panel,
#game-hud button,
#game-hud input {
    pointer-events: auto;  /* these capture clicks */
}

/* Lobby screens — fully interactive, blocks canvas */
#lobby-ui {
    position: fixed;
    inset: 0;
    z-index: 100;
    pointer-events: auto;  /* blocks all canvas interaction */
}
```

### Drag operations

When a mousedown occurs:
1. Record whether it started on a UI element or the canvas
2. If started on canvas: all subsequent mousemove/mouseup events go to the canvas handler (box select, camera pan), even if the cursor moves over a UI element
3. If started on UI: all subsequent events go to the UI element (scrollbar drag, slider, etc.)

This prevents cross-boundary drag artifacts. Implemented via a global `isDraggingCanvas` flag set on mousedown.

### Right-click

Right-click on canvas → game command (move, attack).
Right-click on UI → context menu (if applicable) or suppress via `oncontextmenu`.

The canvas should call `event.preventDefault()` on contextmenu to suppress the browser's default right-click menu.

## UI Component Stack

### z-index layout

| z-index | Element | pointer-events | Purpose |
|---------|---------|----------------|---------|
| 0 | `#game-canvas` | auto | WebGL rendering |
| 10 | `#game-hud` | none (container) | In-game HUD frame |
| 11 | `.hud-panel` | auto | Selection info, command buttons |
| 12 | `#minimap-container` | auto | Minimap (HTML canvas) |
| 15 | `#chat-panel` | auto | Chat input/history |
| 20 | `#resource-bar` | auto | Top bar with resources |
| 100 | `#lobby-ui` | auto | Login, room browser, room setup |
| 200 | `#modal-overlay` | auto | Confirmation dialogs, settings |
| 300 | `#perf-overlay` | none | Performance metrics (F11) |

### Game states and UI visibility

| State | Canvas | HUD | Lobby | Modals |
|-------|--------|-----|-------|--------|
| Login | hidden | hidden | visible (login form) | — |
| Lobby browser | hidden | hidden | visible (room list) | — |
| Room setup | hidden | hidden | visible (room view) | — |
| Loading | visible (terrain) | hidden | hidden | loading overlay |
| Playing | visible | visible | hidden | on demand |
| Game over | visible (frozen) | visible | hidden | results overlay |

## Game-Specific UI

Games (Paper Tanks, Metalstorm, etc.) can define custom HUD elements by:

1. **JS widgets** — register a Widget with `widgetManager.addWidget()` that creates HTML elements in its `onActivate()` hook and removes them in `onDeactivate()`
2. **CSS themes** — games ship a CSS file that styles the HUD panels
3. **Event hooks** — widgets receive entity state, combat events, and input events to drive their UI

Games do NOT have access to WebGL drawing commands for UI. All UI is HTML. This is a deliberate simplification — HTML/CSS is more capable, more accessible, and more familiar to web developers than a custom GL UI framework.

## Minimap

The minimap is an HTML `<canvas>` element (2D context) rendered inside a positioned div. It does not use WebGL.

- Draws a downscaled version of the heightmap as a background
- Renders unit positions as colored circles (1-3px)
- Updates at ~10Hz (matches entity state update rate)
- Click on minimap → move camera to that position
- Drag on minimap → pan camera

This avoids the complexity of a second WebGL context and keeps the minimap lightweight.

## Chat

Chat uses a simple HTML text input + scrollable message list.

- Global chat visible in lobby
- Room chat visible in room setup and during game
- Team chat (allies only) during game
- All chat (everyone including spectators) during game
- Messages sent via the existing ChatSend/ChatReceive FlatBuffers messages

## Accessibility

HTML UI is inherently more accessible than GL-rendered UI:
- Screen readers can parse text content
- Keyboard navigation works via tabindex
- High-contrast mode is handled by browser/OS
- Font scaling respects browser settings
