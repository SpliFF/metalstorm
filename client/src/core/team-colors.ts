// Spring engine's 10 default team colors (from TeamBase::teamDefaultColor).
// Shared by the unit/impostor materials; minimap.ts and
// standing-order-renderer.ts keep their own raw-tuple copies (canvas/UI
// paths that don't want Babylon imports).

import { Color3 } from '@babylonjs/core';

export const TEAM_COLORS = [
    new Color3(90 / 255, 90 / 255, 255 / 255),    // blue
    new Color3(200 / 255, 0 / 255, 0 / 255),      // red
    new Color3(255 / 255, 255 / 255, 255 / 255),  // white
    new Color3(38 / 255, 155 / 255, 32 / 255),    // green
    new Color3(7 / 255, 31 / 255, 125 / 255),     // dark blue
    new Color3(150 / 255, 10 / 255, 180 / 255),   // purple
    new Color3(255 / 255, 255 / 255, 0 / 255),    // yellow
    new Color3(50 / 255, 50 / 255, 50 / 255),     // black
    new Color3(152 / 255, 200 / 255, 220 / 255),  // light blue
    new Color3(171 / 255, 171 / 255, 131 / 255),  // tan
];

export function getTeamColor(team: number): Color3 {
    return TEAM_COLORS[team % TEAM_COLORS.length];
}
