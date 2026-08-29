/**
 * camera-travel.ts — "go there", on anything that names somewhere
 * (DESIGN-DRILLDOWN.md §5, the U0 framework)
 *
 * The directive's closing line is "if they see something interesting, one more
 * click gets them there, INCLUDING camera travel". That makes travel a
 * property of a *reference*, not a feature of a particular panel: wherever a
 * `FocusRef` is rendered — a summary chip, a row in a context panel, an
 * objective, a contact ping — the same affordance appears, looks the same, and
 * goes through the same code.
 *
 * ── One path, and why it is `cameraSnapToGround` ──
 *
 * The camera has lived in the game-processor worker since GW8; main can only
 * reach it through `workerCall`, which is what `CameraPort` wraps. Of the ops
 * that port exposes, exactly one frames a map position against the TERRAIN:
 * `cameraSnapToGround`, which samples the heightmap for its look-at. `focusOn`
 * pans to sea level, and `setCameraPose` is a raw pose the rig deliberately
 * ignores. So every travel here funnels into `CameraPort.travelTo` /
 * `snapToUnit` (which is `snapToGround` on a worker-resolved unit position),
 * and no caller is given a way to move the camera any other way.
 *
 * ── Refusing out loud ──
 *
 * `travelTo` returns a boolean and `createGoThereButton` renders DISABLED for a
 * ref that has neither a position nor members. A "go there" that quietly does
 * nothing teaches a new player that the UI is broken — which is the failure
 * mode this whole framework exists to remove — so an untravellable ref shows
 * its affordance greyed with a title saying why, or shows nothing at all.
 */

import { cameraPortHolder } from './camera-port.js';
import type { FocusRef } from './focus-model.js';

/** How long a drill-down travel takes. Long enough to read as the camera
 *  MOVING (so the player keeps their bearings and learns where the thing was
 *  relative to where they were), short enough not to feel like a cutscene. */
export const TRAVEL_DURATION_MS = 600;

export type TravelTarget =
    | FocusRef
    | { x: number; z: number }
    | { unitId: number };

export type TravelRefusal = 'no-camera' | 'no-target';

export interface TravelResult {
    ok: boolean;
    /** Why not, when `ok` is false. */
    reason?: TravelRefusal;
}

/** Can this target be travelled to at all? Drives the disabled state of every
 *  "go there" affordance, so the answer is computed once, here. */
export function canTravelTo(target: TravelTarget): boolean {
    return resolveTarget(target) !== null;
}

/**
 * Send the camera to `target`.
 *
 * A ref with a `position` travels by ground position. A ref with only
 * `unitIds` travels by its first member, resolved worker-side — which is how a
 * squad is reachable before any census snapshot has arrived, and why the
 * summary chip's button is live the instant a selection lands.
 */
export function travelTo(
    target: TravelTarget,
    opts: { durationMs?: number } = {},
): TravelResult {
    const port = cameraPortHolder.current;
    if (!port) return { ok: false, reason: 'no-camera' };

    const resolved = resolveTarget(target);
    if (!resolved) return { ok: false, reason: 'no-target' };

    const durationMs = opts.durationMs ?? TRAVEL_DURATION_MS;
    if (resolved.kind === 'ground') {
        port.travelTo(resolved.x, resolved.z, { durationMs });
    } else {
        port.snapToUnit(resolved.unitId, { durationMs });
    }
    return { ok: true };
}

/**
 * The affordance itself: a small button that travels when clicked.
 *
 * Rendered by every rung of the ladder that shows a reference, so its look and
 * its wording are decided once. `onTravel` exists for the surface that wants
 * to react (collapse itself, echo a transcript line) without re-deriving
 * whether the travel actually happened.
 */
export function createGoThereButton(
    target: TravelTarget,
    opts: { label?: string; onTravel?: (result: TravelResult) => void } = {},
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nui-btn nui-btn--sm nui-go-there';
    btn.textContent = opts.label ?? 'Go there';

    if (!canTravelTo(target)) {
        btn.disabled = true;
        btn.title = 'No position known for this yet';
        return btn;
    }

    btn.title = 'Send the camera here';
    btn.addEventListener('click', (e) => {
        // A "go there" inside a drill-down row must not also toggle the row.
        e.stopPropagation();
        const result = travelTo(target);
        opts.onTravel?.(result);
    });
    return btn;
}

// ──────────────────────────────── internals ─────────────────────────────

type ResolvedTarget =
    | { kind: 'ground'; x: number; z: number }
    | { kind: 'unit'; unitId: number };

function resolveTarget(target: TravelTarget): ResolvedTarget | null {
    if ('unitId' in target && typeof target.unitId === 'number') {
        return { kind: 'unit', unitId: target.unitId };
    }
    if ('x' in target && 'z' in target &&
        typeof target.x === 'number' && typeof target.z === 'number') {
        return { kind: 'ground', x: target.x, z: target.z };
    }

    const ref = target as FocusRef;
    // Position first: a known ground position is stable, whereas a member id
    // can be a unit that died between render and click.
    if (ref.position && Number.isFinite(ref.position.x) && Number.isFinite(ref.position.z)) {
        return { kind: 'ground', x: ref.position.x, z: ref.position.z };
    }
    const first = ref.unitIds?.[0];
    if (typeof first === 'number') return { kind: 'unit', unitId: first };
    return null;
}
