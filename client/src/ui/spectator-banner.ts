/**
 * Spectator banner — engine-level (not game-specific), shown whenever the
 * local session's role is "spectator" (PLAN-metalstorm-onboarding.md §4).
 *
 * Deliberately independent of the native-ui widget system: spectator mode
 * is a lobby/permissions concept that applies to every game (BAR/ZK included,
 * neither of which run native-ui), not a Metalstorm HUD panel.
 */

let bannerEl: HTMLElement | null = null;

/** Show the banner with a working Enlist button. `onEnlist` should resolve
 *  once the lobby's `/api/rooms/enlist` call completes (success or not);
 *  a rejection re-enables the button so the player can retry. */
export function showSpectatorBanner(onEnlist: () => Promise<boolean>): void {
    hideSpectatorBanner();

    const el = document.createElement('div');
    el.id = 'spectator-banner';
    el.style.cssText =
        'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:200;' +
        'display:flex;align-items:center;gap:10px;padding:6px 14px;border-radius:6px;' +
        'background:rgba(20,20,24,0.85);color:#fff;font:13px system-ui,sans-serif;' +
        'pointer-events:auto;';

    const label = document.createElement('span');
    label.textContent = 'Spectating';

    const btn = document.createElement('button');
    btn.textContent = 'Enlist';
    btn.style.cssText =
        'cursor:pointer;padding:2px 10px;border-radius:4px;border:none;' +
        'background:#3b82f6;color:#fff;font:inherit;';
    btn.onclick = () => {
        btn.disabled = true;
        btn.textContent = '…';
        onEnlist().then((ok) => {
            if (ok) {
                label.textContent = "Enlisted — you'll take your seat when the game restarts";
                btn.remove();
            } else {
                btn.disabled = false;
                btn.textContent = 'Enlist';
            }
        }).catch((e) => {
            console.error('[spectator-banner] enlist failed:', e);
            btn.disabled = false;
            btn.textContent = 'Enlist';
        });
    };

    el.appendChild(label);
    el.appendChild(btn);
    document.body.appendChild(el);
    bannerEl = el;
}

export function hideSpectatorBanner(): void {
    bannerEl?.remove();
    bannerEl = null;
}
