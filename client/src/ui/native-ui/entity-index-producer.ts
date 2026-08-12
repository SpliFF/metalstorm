/**
 * entity-index-producer.ts — the live producer for the named-entity index.
 *
 * The named-entity index (named-entity-index.ts) is a pure searchable store;
 * the command composer's Target picker and free-text accelerator read it, but
 * until now NOTHING wrote to it — so in a real session the Target slot found
 * nothing and the composer fell back to `window.prompt()`. This module closes
 * that gap: it is the missing link in the producer path
 *
 *     metalstorm gadgets  →  rulesParams (region_*, objective_*)  →
 *     game-processor worker  →  main-thread `gp:rulesParamUpdate` /
 *     `gp:orgGroups`  →  ui-store  →  [THIS]  →  namedEntityIndex
 *
 * It subscribes to the ui-store paths that carry named entities and rebuilds
 * the whole index on any change (change-driven, never per-frame — rulesParams
 * updates are already batched). A full rebuild (rather than an incremental
 * diff) is correct here because the source is small (tens of regions +
 * objectives + groups) and `replaceAll` collapses it to a single index
 * notification.
 *
 * Entity sources, and why each lives where it does:
 *   - regions    — gameRulesParams `region_<key>_name/_x/_z` (game_regions.lua),
 *                  authored names on a graph map, derived "Sector B9" names on
 *                  a grid one — the same shape either way, which is why grid
 *                  maps becoming addressable needed no change here
 *   - objectives — gameRulesParams `objective_<id>_*` + `objective_count`
 *                  (game_objectives.lua); region-hinted objectives borrow the
 *                  parsed region's centroid + name
 *   - landmarks  — gameRulesParams `landmark_<name>_x/_z` (+ optional `_name`),
 *                  published by game_scenario.lua for any `units` /
 *                  `world.features` entry carrying a `name`: the resource
 *                  sites, ancient-tech relics and bridge crossings a scenario
 *                  places (PLAN-metalstorm-model-integration §M4). This shape
 *                  was parsed here with no producer at all until that landed.
 *   - org groups — the ui-store org-group snapshot (`gp:orgGroups`, own team),
 *                  NOT a rulesParams shape: groups already have a live producer
 *                  (main.ts → uiStore.updateOrgGroups) and are mirrored into the
 *                  index only so the Subject picker and the accelerator can
 *                  resolve a group by name
 */

import { uiStore, type UIStore, type OrgGroupSummary } from './ui-store.js';
import {
    namedEntityIndex,
    NamedEntityIndex,
    parseRegionsFromRulesParams,
    parseObjectivesFromRulesParams,
    parseLandmarksFromRulesParams,
    type NamedEntity,
    type EntityType,
} from './named-entity-index.js';

/** Map an org-group echelon to the entity type the accelerator's Subject
 *  vocabulary expects (`SUBJECT_ENTITY_TYPES = ['group','platoon','army']`). */
function echelonToEntityType(echelon: OrgGroupSummary['echelon']): Extract<EntityType, 'group' | 'platoon' | 'army'> {
    if (echelon === 'Platoon') return 'platoon';
    if (echelon === 'Army') return 'army';
    return 'group';
}

/**
 * Convert the ui-store org-group snapshot into named entities.
 *
 * Exported (and pure) so it is unit-testable without a store. Groups carry no
 * centroid in the snapshot (`OrgGroupSummary` has memberIds + baseCostSum but
 * no aggregate position — the worker doesn't compute one), so `x/z` are 0:
 * a group is a *Subject* (who acts), not a *Target* (where to act), and the
 * Subject picker never locate-pings it. If group location is ever needed, the
 * fix is to have the worker emit a centroid on `gp:orgGroups`, not to guess
 * one here.
 */
export function orgGroupsToEntities(groups: readonly OrgGroupSummary[]): NamedEntity[] {
    return groups.map((g) => ({
        id: g.groupId,
        type: echelonToEntityType(g.echelon),
        name: g.name || `Group ${g.groupId}`,
        x: 0,
        z: 0,
        metadata: { echelon: g.echelon, memberCount: g.memberIds.length, baseCostSum: g.baseCostSum },
    }));
}

/**
 * Rebuild the entire index from the current store snapshot.
 *
 * Regions are parsed first so region-hinted objectives can resolve their
 * position and name against them.
 */
export function rebuildEntityIndex(store: UIStore, index: NamedEntityIndex): void {
    const game = store.getGameRulesParams();

    const regions = parseRegionsFromRulesParams(game);
    const regionByKey = new Map(regions.map((r) => [String(r.id), r]));
    const resolveRegion = (key: string) => {
        const r = regionByKey.get(key);
        return r ? { name: r.name, x: r.x, z: r.z } : undefined;
    };

    const objectives = parseObjectivesFromRulesParams(game, resolveRegion);
    const landmarks = parseLandmarksFromRulesParams(game);
    const groups = orgGroupsToEntities(store.getOrgGroups());

    index.replaceAll([...regions, ...objectives, ...landmarks, ...groups]);
}

/**
 * Start the producer: subscribe to the store paths that carry named entities
 * and rebuild the index on every change (plus once immediately). Returns a
 * dispose function that unsubscribes and clears the index.
 *
 * `teamRulesParams` is included in the subscription because org-group / pool
 * changes arrive on that path and a future team-scoped named entity would too;
 * today the rebuild simply re-reads game params, which is cheap.
 */
export function startEntityIndexProducer(
    store: UIStore = uiStore,
    index: NamedEntityIndex = namedEntityIndex,
): () => void {
    const rebuild = () => rebuildEntityIndex(store, index);

    const unsub = store.subscribe(['gameRulesParams', 'teamRulesParams', 'orgGroups'], rebuild);
    rebuild(); // seed from whatever state already arrived before we subscribed

    return () => {
        unsub();
        index.clear();
    };
}
