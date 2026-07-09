/**
 * Scenario registry — single source of truth for what `?scenario=<name>`
 * can resolve to. Add new scenarios here.
 *
 * The runner imports `getScenario` to look up the URL slug, and
 * `listScenarios` to print a "did you mean…" hint when the slug
 * doesn't match.
 */

import type { Scenario } from './types.js';
import duelAttack from './bench/duel-attack.js';
import aimRotation from './bench/aim-rotation.js';
import movePathing from './bench/move-pathing.js';
import unitTestLoop from './bench/unit-test-loop.js';
import weaponFx from './bench/weapon-fx.js';
import weaponShowcase from './bench/weapon-showcase.js';
import modelViewer from './model-viewer/index.js';
import lobbyFlow from './bench/lobby-flow.js';

const SCENARIOS: Scenario[] = [
    duelAttack,
    aimRotation,
    movePathing,
    unitTestLoop,
    weaponFx,
    weaponShowcase,
    modelViewer,
    lobbyFlow,
];

const BY_NAME = new Map<string, Scenario>(SCENARIOS.map((s) => [s.name, s]));

export function getScenario(name: string): Scenario | undefined {
    return BY_NAME.get(name);
}

export function listScenarios(): readonly Scenario[] {
    return SCENARIOS;
}
