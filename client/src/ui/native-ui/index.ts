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
