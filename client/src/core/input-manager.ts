/**
 * REMOVED (PLAN-playable.md G3b, 2026-07-09).
 *
 * The main-thread `InputManager` — the pre-GW4 DOM-coupled owner of unit
 * selection, right-click orders, build placement, build-drag rows, waypoint
 * drag, area-attack drag, modal pending-commands, animated cursors, and order
 * hotkeys — has been fully ported into the game-processor worker (post-GW4 the
 * canvas pointer/key events forward there, where the Babylon scene + camera +
 * connection live). It was never instantiated post-GW4; this file's logic is
 * dead and has been removed to avoid dual-maintenance.
 *
 * Where each responsibility now lives:
 *   - selection / pick / right-click orders → `worker-selection.ts`
 *   - build placement + ghost + mex snap + build-drag rows + pending-ghost
 *     lifecycle → `worker-build-placement.ts`
 *   - modal pending-commands + area-attack drag + waypoint drag/revoke + order
 *     hotkeys + cursor-mode → `worker-command-modes.ts`
 *   - the animated-cursor DOM overlay (driven by the worker's `gp:cursorMode`)
 *     → `animated-cursor.ts` (revived in `main.ts` G3b)
 *
 * This stub remains only because the working tree could not delete the file in
 * this environment; it exports nothing and is imported by nothing. Safe to
 * `git rm`.
 */
export {};
