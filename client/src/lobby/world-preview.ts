/**
 * world-preview.ts — the harness behind `world-preview.html`.
 *
 * PLAN-worldsim.md W2's screenshot check. It mounts the real browser-screen
 * markup and stylesheet, hands `WorldScreen` a fixture in place of the lobby's
 * HTTP, and opens the map — so what the screenshot shows is the shipped
 * template, the shipped CSS and the shipped drawing code. Dev-server only (not
 * a build input); nothing in the client imports it.
 *
 * The fixture is real geography on purpose: Earth is the one basemap where a
 * wrong projection is obvious to a human looking at the picture, which is the
 * half of the verification the vitest transform tests cannot do. If Reykjavík
 * is not on Iceland, the screenshot has failed even though every assertion in
 * `world-map.test.ts` passed.
 */

import lobbyCss from '../ui/lobby/lobby.css?raw';
import browserHtml from '../ui/lobby/browser/browser.html?raw';
import { WorldScreen } from './world-screen.js';

const POIS = {
    worldId: 'earth',
    pois: [
        { id: 'reykjavik', name: 'Skerry Reach', lat: 64.15, lon: -21.94, kind: 'outpost', mapId: 'skerry_reach', battleStatus: 'quiet', warRoomId: null, owner: 'house-verendi', tags: ['arctic', 'coastal'], config: {} },
        // PLAN-worldsim.md W5: one active and one staging POI in the fixture,
        // so the screenshot proves the two new marker states are drawn, not
        // just parsed.
        { id: 'paris', name: 'Randtown', lat: 48.86, lon: 2.35, kind: 'settlement', mapId: 'meridian_basin', battleStatus: 'active', warRoomId: 7, owner: 'third-armoured', tags: ['temperate', 'contested'], config: {} },
        { id: 'cairo', name: 'Dune Reach', lat: 30.04, lon: 31.24, kind: 'depot', mapId: 'dune_reach', battleStatus: 'staging', warRoomId: 12, owner: 'the-14th-of-ash', tags: ['arid'], config: {} },
        { id: 'novosibirsk', name: 'Frost Reach', lat: 55.03, lon: 82.92, kind: 'settlement', mapId: 'frost_reach', battleStatus: 'quiet', warRoomId: null, tags: ['boreal'], config: {} },
        { id: 'manaus', name: 'Verdant Shoals', lat: -3.12, lon: -60.02, kind: 'settlement', mapId: 'verdant_shoals', battleStatus: 'quiet', warRoomId: null, tags: ['jungle'], config: {} },
        { id: 'perth', name: 'Techno Lands', lat: -31.95, lon: 115.86, kind: 'foundry', mapId: 'techno_lands', battleStatus: 'quiet', warRoomId: null, owner: 'warhounds', tags: ['industrial'], config: {} },
        { id: 'ushuaia', name: 'Pools of Ilys', lat: -54.8, lon: -68.3, kind: 'relay', mapId: null, battleStatus: 'quiet', warRoomId: null, tags: ['remote'], config: {} },
        { id: 'honolulu', name: 'Crossing Standoff', lat: 21.31, lon: -157.86, kind: 'waystation', mapId: 'crossing_standoff', battleStatus: 'quiet', warRoomId: null, tags: ['oceanic'], config: {} },
    ],
    edges: [
        { from: 'reykjavik', to: 'paris', transitWorldMs: 3600000 * 18, kind: 'sea', bidirectional: true, config: {} },
        { from: 'paris', to: 'cairo', transitWorldMs: 3600000 * 26, kind: 'road', bidirectional: true, config: {} },
        { from: 'cairo', to: 'novosibirsk', transitWorldMs: 3600000 * 40, kind: 'road', bidirectional: true, config: {} },
        { from: 'paris', to: 'manaus', transitWorldMs: 3600000 * 52, kind: 'sea', bidirectional: true, config: {} },
        { from: 'manaus', to: 'ushuaia', transitWorldMs: 3600000 * 30, kind: 'sea', bidirectional: true, config: {} },
        { from: 'novosibirsk', to: 'perth', transitWorldMs: 3600000 * 61, kind: 'air', bidirectional: false, config: {} },
        { from: 'perth', to: 'honolulu', transitWorldMs: 3600000 * 44, kind: 'sea', bidirectional: true, config: {} },
        { from: 'honolulu', to: 'manaus', transitWorldMs: 3600000 * 55, kind: 'sea', bidirectional: true, config: {} },
    ],
    // PLAN-worldsim.md W7: one faction per archetype, so the screenshot shows
    // the four owner colours against the basemap as well as the detail
    // panel's "Held by" line — the half of the check a DOM assertion is blind
    // to. `warhounds` is deliberately owned-but-unbadged nowhere: every owner
    // here has a badge, and the unbadged fallback is covered in vitest.
    factions: {
        'third-armoured': { name: 'Third Armoured', colour: '#5b9bd5', archetype: 'order', state: 'active' },
        'house-verendi': { name: 'House Verendi', colour: '#c9a227', archetype: 'dynasty', state: 'active' },
        'the-14th-of-ash': { name: 'The 14th of Ash', colour: '#c0504d', archetype: 'resistance', state: 'active' },
        'warhounds': { name: 'Warhounds', colour: '#7f9a4e', archetype: 'anarchic', state: 'active' },
    },
};

const style = document.createElement('style');
style.textContent = lobbyCss;
document.head.appendChild(style);
document.getElementById('lobby-root')!.innerHTML = browserHtml
    .replace('{{account_name}}', 'preview');

// PLAN-worldsim.md W8: the player panel's own fixture — the body
// `WorldStats::AttachMeStats` builds. One commander stationed and one on loan,
// so the screenshot carries the loan marker and the "excluded" rank line,
// which are the two things a reader has to be able to see to trust the number.
const ME = {
    worldId: 'earth',
    accountId: 7,
    authority: 120,
    canFound: true,
    membership: { factionId: 'third-armoured', role: 'founder', rank: 0, name: 'Third Armoured', colour: '#5b9bd5' },
    commanders: [
        { commanderId: 'vex-1', name: 'Marshal Vex', factionId: 'third-armoured', poiId: 'paris', state: 'active', authority: 86.4, authorityStored: 92, loaned: false },
        { commanderId: 'vex-2', name: 'Adjutant Rell', factionId: 'third-armoured', poiId: 'cairo', state: 'active', authority: 24, authorityStored: 24, loaned: true, loanedTo: 9 },
    ],
    capacity: { max: 28.6, spent: 11, available: 17.6, rechargedAt: 0, nextRechargeInMs: 3600000 * 6 + 60000 * 40, rechargeHours: 24 },
    rank: {
        factionId: 'third-armoured', total: 121.4, commanderCount: 1, poiCount: 1, loanedCount: 1,
        terms: { commanders: 10, commanderAuthority: 86.4, regions: 25, money: 0, resources: 0, units: 0, artifacts: 0 },
    },
};

const screen = new WorldScreen({
    get: async (path: string) => {
        if (path === '/api/world') return { worldId: 'earth', name: 'Earth', state: 'active' };
        if (path === '/api/world/pois') return POIS;
        return null;
    },
    post: async (path: string) => (path === '/api/world/me' ? ME : null),
});
void screen.probe();
screen.open();
// Preselect a POI so the screenshot carries the detail panel populated: the
// map and the panel are one feature, and a photograph of the map alone would
// not show that they agree about which place is selected.
void screen.refresh().then(() => screen.selectPoi('paris'));
(window as unknown as Record<string, unknown>).__worldScreen = screen;
