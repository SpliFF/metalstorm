/**
 * REMOVED (PLAN-playable.md G3b, 2026-07-09).
 *
 * The main-thread `OrderPanel` was the DOM order-button strip that mirrored the
 * pre-GW4 `InputManager` keyboard hotkeys. It depended on `InputManager` (now
 * removed) and was never instantiated post-GW4 — the order UI is a LuaUI widget
 * in the worker, and order hotkeys / modal arming now live in
 * `worker-command-modes.ts`. Its logic is dead and has been removed to avoid
 * dual-maintenance.
 *
 * This stub remains only because the working tree could not delete the file in
 * this environment; it exports nothing and is imported by nothing. Safe to
 * `git rm`.
 */
export {};
