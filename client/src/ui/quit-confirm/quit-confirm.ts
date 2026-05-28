/**
 * Quit-to-lobby confirmation overlay.
 *
 * Toggle-safe: calling `showQuitConfirm` while the overlay is already
 * visible closes it instead, so ESC works as an open/close toggle.
 */

import { injectStyle } from '../ui.js';
import type { GameTemplates } from '../game/loader.js';

export interface QuitConfirmCallbacks {
    onConfirm: () => void;
}

export function showQuitConfirm(
    templates: GameTemplates, callbacks: QuitConfirmCallbacks,
): void {
    const existing = document.getElementById('quit-confirm-overlay');
    if (existing) {
        existing.remove();
        return;
    }

    injectStyle('quit-confirm-style', templates.quitConfirmCss);

    const overlay = document.createElement('div');
    overlay.id = 'quit-confirm-overlay';
    overlay.innerHTML = templates.quitConfirmHtml;
    document.body.appendChild(overlay);

    document.getElementById('quit-cancel-btn')?.addEventListener('click', () => {
        overlay.remove();
    });
    document.getElementById('quit-confirm-btn')?.addEventListener('click', callbacks.onConfirm);
}
