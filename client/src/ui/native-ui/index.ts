/**
 * native-ui/index.ts — Native JS UI system exports
 */

export { UIStore, uiStore } from './ui-store.js';
export type { PlayerInfo, UnitSelection, TeamEconomy, OrgGroupSummary } from './ui-store.js';

// Map-arm gesture bridge (PLAN-metalstorm-scripting.md task 4)
export { mapGestureBridge } from './map-gesture.js';
export type { MapGestureShape, MapGestureArmOpts, MapGestureResult } from './map-gesture.js';

// Cost preview + Subject two-way sync (PLAN-metalstorm-scripting.md task 5 / task 4)
export { orderClassForEchelon, previewDirectiveCost, matchSelectionToGroup } from './cost-preview.js';
export type { Echelon, CostModelLike, OrgGroupLike, CostPreview } from './cost-preview.js';

export { WidgetLoader } from './widget-loader.js';
export type {
    WidgetManifest,
    WidgetDescriptor,
    WidgetContext,
    Widget,
} from './widget-loader.js';

export {
    initializeNativeUI,
    wireRulesParamsToStore,
    handleRulesParamUpdate,
    disposeNativeUI,
} from './integration.js';

// Named-entity index (PLAN-metalstorm-scripting.md §4)
export { NamedEntityIndex, namedEntityIndex } from './named-entity-index.js';
export type { EntityType, NamedEntity } from './named-entity-index.js';
export {
    parseRegionsFromRulesParams,
    parseObjectivesFromRulesParams,
    parseLandmarksFromRulesParams,
    parseOrgGroupsFromTeamRulesParams,
} from './named-entity-index.js';

// Compile table (PLAN-metalstorm-scripting.md §5)
export {
    compileIntent,
    validateIntent,
    getPriorityBand,
    getAcceptedTargetShapes,
    PRIORITY_BANDS,
    TARGET_SHAPES_BY_VERB,
    DirectiveType,
    StandingOrderType,
    OrderShape,
} from './compile-table.js';
export type {
    CommandVerb,
    TargetShape,
    CommandSubject,
    CommandTarget,
    WhenCondition,
    CommandIntent,
    CompiledMessage,
    GroupDirectivePayload,
    StandingOrderPayload,
    AIGuidancePayload,
} from './compile-table.js';
