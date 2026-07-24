/**
 * native-ui/index.ts — Native JS UI system exports
 */

export { UIStore, uiStore } from './ui-store.js';
export type { PlayerInfo, UnitSelection, TeamEconomy } from './ui-store.js';

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
    PRIORITY_BANDS,
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
