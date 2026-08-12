/**
 * native-ui/index.ts — Native JS UI system exports
 */

export { UIStore, uiStore } from './ui-store.js';
export type {
    PlayerInfo, UnitSelection, TeamEconomy, OrgGroupSummary, DirectiveSummary,
} from './ui-store.js';

// Progressive disclosure (PLAN-native-ui.md §3, onboarding §5)
export { parseRevealPredicate } from './reveal-predicate.js';
export type { RevealPredicate, RevealStorePath, RevealIdentity } from './reveal-predicate.js';

// Map-arm gesture bridge (PLAN-metalstorm-scripting.md task 4)
export { mapGestureBridge } from './map-gesture.js';
export type { MapGestureShape, MapGestureArmOpts, MapGestureResult } from './map-gesture.js';

// Cost preview + Subject two-way sync (PLAN-metalstorm-scripting.md task 5 / task 4)
export { previewDirectiveCost, matchSelectionToGroup } from './cost-preview.js';
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
export type { CommandConnection } from './integration.js';

// Named-entity index (PLAN-metalstorm-scripting.md §4)
export { NamedEntityIndex, namedEntityIndex } from './named-entity-index.js';
export type { EntityType, NamedEntity } from './named-entity-index.js';
export {
    parseRegionsFromRulesParams,
    parseObjectivesFromRulesParams,
    parseLandmarksFromRulesParams,
} from './named-entity-index.js';

// Named-entity index live producer (rulesParams / org-groups → index)
export {
    startEntityIndexProducer,
    rebuildEntityIndex,
    orgGroupsToEntities,
} from './entity-index-producer.js';

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

// Command-composer presets (PLAN-metalstorm-scripting.md task 6)
export {
    configureCommandPresets,
    listCommandPresets,
    saveCommandPreset,
    deleteCommandPreset,
} from './command-presets.js';
export type { CommandPreset } from './command-presets.js';

// Natural-language command language, M3 local verbs
// (PLAN-metalstorm-command-language.md §6.2-§6.4)
export { CameraPort, cameraPortHolder, createNLCameraPort } from './camera-port.js';
export type { CameraPose, CameraPortDeps, FollowTarget, FollowEndReason } from './camera-port.js';
export {
    UiActionRegistry, uiActionRegistry, createNLUiActionPort, normalisePanelName,
} from './ui-action-registry.js';
export type { UiActionEntry, UiActionOp, UiActionResult } from './ui-action-registry.js';
export { QueryEngine, CensusCache, censusCacheHolder, NOT_SPOTTED } from './query-engine.js';
export type { Census, CensusUnit, CensusPort, QueryEngineDeps } from './query-engine.js';
export { matchLocalPattern } from './nl-local-patterns.js';
export type { LocalPatternDeps, LocalPatternMatch } from './nl-local-patterns.js';
