/**
 * In-game HUD — entity / frame / selection readouts + speed indicator.
 *
 * The HUD's HTML/CSS comes from `gameTemplates.hudHtml` + `hudCss`
 * (engine defaults with optional per-game override). `createHUD` injects
 * the stylesheet once and (re)builds the `#game-hud` element; callers
 * pass it on first boot AND again whenever a game's template override
 * lands so the override actually replaces the default markup.
 */

import { injectStyle } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';

export interface HudCallbacks {
    onQuit: () => void;
}

/**
 * Build (or rebuild) the HUD root. Removes any previous instance first
 * so a template hot-swap doesn't leave stale nodes.
 */
export function createHUD(templates: GameTemplates, callbacks: HudCallbacks): void {
    document.getElementById('game-hud')?.remove();
    document.getElementById('hud-style')?.remove();

    injectStyle('hud-style', templates.hudCss);

    const hud = document.createElement('div');
    hud.id = 'game-hud';
    hud.style.display = 'none'; // hidden until game starts
    hud.innerHTML = templates.hudHtml;
    document.body.appendChild(hud);

    // Quit is reachable via ESC (toggle quit-confirm) and the in-game
    // chili menu (F10 → widget list / game menu). The HUD's static Quit
    // button was removed because it sat under the chili HUD bar; if a
    // future template re-adds #hud-quit-btn this guard simply skips.
    document.getElementById('hud-quit-btn')?.addEventListener('click', callbacks.onQuit);
}

export function showHUD(): void {
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'block';
}

export function hideHUD(): void {
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'none';
}

/**
 * Last text written to each readout. `updateHUD` is called from the render
 * loop's scene-state message (main.ts), i.e. at frame rate, and every readout
 * it touches is `display:none` by default (see hud.html) — so before this
 * cache it was three `textContent` writes per frame into elements nobody
 * could see. A write is now made only when the string actually changes,
 * which for the selection readout is "when the player clicks" and for the
 * frame counter is never, because that element is hidden and its text is
 * only interesting to a debugger who can read `window.test`.
 */
const lastWritten = { entities: '', frame: '', selected: '' };

/** Write `text` to `#<id>` only if it differs from the last write. */
function writeIfChanged(id: string, key: keyof typeof lastWritten, text: string): void {
    if (lastWritten[key] === text) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    lastWritten[key] = text;
}

/** Testable formatting of the selection readout. Exported for hud tests. */
export function selectionReadout(selectedIds: readonly number[]): string {
    if (selectedIds.length === 0) return 'No selection';
    if (selectedIds.length === 1) return `Selected: unit ${selectedIds[0]}`;
    return `Selected: ${selectedIds.length} units`;
}

export function updateHUD(
    entityCount: number, frame: number, selectedIds: readonly number[],
): void {
    writeIfChanged('hud-entities', 'entities', `Entities: ${entityCount}`);
    writeIfChanged('hud-frame', 'frame', `Frame: ${frame}`);
    writeIfChanged('hud-selected', 'selected', selectionReadout(selectedIds));
}

/** Test hook: forget the write cache (a rebuilt HUD has fresh elements). */
export function resetHUDWriteCache(): void {
    lastWritten.entities = '';
    lastWritten.frame = '';
    lastWritten.selected = '';
}

/**
 * Render the sim-speed / pause state in the HUD. Reads from the
 * authoritative `onGameInfo` broadcast so the indicator reflects what
 * the server actually applied (after clamping), not what the player
 * requested. Stays hidden at 1×/unpaused to avoid HUD clutter.
 */
export function updateSpeedHUD(speed: number, paused: boolean): void {
    const el = document.getElementById('hud-speed');
    if (!el) return;
    if (paused) {
        el.textContent = 'PAUSED';
        el.style.display = '';
    } else if (Math.abs(speed - 1) > 0.01) {
        el.textContent = `${speed.toFixed(speed < 1 ? 2 : 1)}×`;
        el.style.display = '';
    } else {
        el.style.display = 'none';
    }
}
