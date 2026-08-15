/**
 * PLAN-test-automation P7 — gate 3 of the browser-eval relay.
 *
 * The server can only offer an eval; whether the browser honours it is decided
 * here. Two gates already stand upstream (the route is compiled out under
 * SPRING_PROD, and only an admin-role session is ever addressed), but both live
 * in a binary that cannot verify what bundle the browser is running. This one
 * can, so it is the gate that makes a production bundle safe on its own terms.
 *
 * Its own module (rather than a closure inside game-processor.ts) so the
 * decision is testable without booting Babylon in a worker.
 */

/** The refusal text the server relays back verbatim; the MCP branches on it. */
export const CLIENT_EVAL_DISABLED = 'client eval disabled in this build';

/** The targets a relayed eval may name. Anything else is a malformed request. */
export const CLIENT_EVAL_TARGETS = ['js', 'worker', 'widgets', 'test'] as const;
export type ClientEvalTarget = (typeof CLIENT_EVAL_TARGETS)[number];

/**
 * Does this build accept relayed evals?
 *
 * @param isDev      `import.meta.env.DEV` — a dev bundle always accepts, with
 *                   no URL param at all. Requiring the param in dev would make
 *                   every debugging session start with a page reload.
 * @param urlOptIn   the page was booted `?allowClientEval=1`. This is the only
 *                   way to open the relay in a production bundle, and it is a
 *                   deliberate act by whoever opened the tab.
 */
export function clientEvalAllowed(isDev: boolean, urlOptIn: boolean): boolean {
    return isDev === true || urlOptIn === true;
}

/** True when `target` is one the executor knows how to run. */
export function isClientEvalTarget(target: string): target is ClientEvalTarget {
    return (CLIENT_EVAL_TARGETS as readonly string[]).includes(target);
}

/**
 * Which thread runs this target. `worker` executes in place (it owns the
 * Connection); everything else is forwarded to main, whose reply rides back
 * through the worker's socket — main has none of its own.
 */
export function clientEvalRunsOnMain(target: string): boolean {
    return target !== 'worker';
}
