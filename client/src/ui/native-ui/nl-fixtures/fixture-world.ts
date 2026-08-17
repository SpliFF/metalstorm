/**
 * nl-fixtures/fixture-world.ts — the world the golden fixtures are resolved against
 * (PLAN-metalstorm-command-language.md §8, milestone M1)
 *
 * A fixture is `{ utterance, context, expected: NLResponse }`. `expected` is
 * what a correct model emits; `context` names the board it was said on. This
 * module turns a named context into the live objects the resolver reads — a
 * `NamedEntityIndex`, an org-group list, a `unitClass` lookup — so all three
 * fixture suites (envelope / executor / resolver) reason about the same world.
 *
 * The fixture `context` is a superset of the §2 wire payload the LLM will
 * actually receive. The payload is names-only by design; a fixture also carries
 * region keys, group ids, sizes and coordinates, because those are what the
 * CLIENT holds and what resolution has to produce. Nothing in `expected` may
 * reference them — that is the property the suites check by construction: every
 * `expected` envelope is name-shaped, and the ids only ever appear on the
 * resolved side.
 */

import {
    NamedEntityIndex, parseLandmarksFromRulesParams, type EntityType, type NamedEntity,
} from '../named-entity-index.js';
import type { OrgGroupSummary } from '../ui-store.js';
import type { ClassVocabulary } from '../class-vocabulary.js';
import { NLResolver, type ResolverDeps } from '../nl-resolver.js';
import { CameraPort, createNLCameraPort } from '../camera-port.js';
import { UiActionRegistry, createNLUiActionPort } from '../ui-action-registry.js';
import { QueryEngine, type Census, type CensusPort, type CensusUnit } from '../query-engine.js';
import type { NLResponse } from '../nl-envelope.js';

// ─────────────────────────── fixture shapes ───────────────────────────

/** A named place. `k` is the region KEY (`region_<k>_name`'s `<k>`) — what the
 *  guidance store paints and what a when-gate references; `n` is what a player
 *  says. Keeping them different in every fixture is deliberate: a resolver that
 *  quietly used the display name as the key would pass with them equal. */
export interface FixturePlace {
    n: string;
    t: Extract<EntityType, 'region' | 'district' | 'city' | 'landmark' | 'enemy-force'>;
    k?: string;
    x: number;
    z: number;
}

export interface FixtureObjective {
    n: string;
    id: number;
    x: number;
    z: number;
}

/** One own-team org group. `cls`/`scale` describe what its members ARE — the
 *  world builder synthesizes member unit ids carrying that `ms_class`/`ms_scale`,
 *  so the resolver's dominant-class logic runs for real rather than being handed
 *  a pre-computed answer. `attach` adds a minority of another class, which is
 *  what makes "modal, not first-member" testable. */
export interface FixtureGroup {
    n: string;
    id: number;
    cls: string;
    scale?: number;
    size: number;
    /** No active directive. Absent ⇒ idle (the common case). */
    busy?: boolean;
    echelon?: OrgGroupSummary['echelon'];
    x?: number;
    z?: number;
    attach?: { cls: string; scale?: number; n: number };
}

/**
 * One entry in the client's LOS-FILTERED mirror (M3's census).
 *
 * This list is the whole world the query engine can see, and that is the point:
 * a fixture puts an enemy squad on the board by NOT listing it here, and the
 * engine's only honest answer becomes "not currently spotted". There is no
 * "visible: false" flag, because there is no such thing in the real mirror —
 * an out-of-LOS enemy is absent, not marked.
 */
export interface FixtureCensusUnit {
    /** Unit id. Omitted ⇒ auto-assigned in the 900000 range (not a group member). */
    id?: number;
    cls: string;
    scale?: number;
    side: 'own' | 'ally' | 'enemy';
    x: number;
    z: number;
}

export interface FixtureContext {
    map?: { name: string };
    places?: FixturePlace[];
    objectives?: FixtureObjective[];
    groups?: FixtureGroup[];
    /**
     * The census the query engine and the camera's group-centroid lookup read.
     *
     * `own` group members are added automatically from `groups` (a squad on the
     * order of battle is by definition in your own mirror), so a context only
     * lists this for enemies, allies and loose own units. Set `noCensus` to model
     * "no snapshot has arrived yet".
     */
    visible?: FixtureCensusUnit[];
    /** Omit the census entirely — every query must refuse, not answer zero. */
    noCensus?: boolean;
    /** Panels the ui-action-registry holds. Defaults to the Metalstorm set. */
    panels?: Array<{ id: string; label: string; aliases?: string[]; fullscreen?: boolean }>;
    /** `gameRulesParams` for `objectives`; `teamRulesParams` for `resources`. */
    gameRulesParams?: Record<string, number | string>;
    teamRulesParams?: Record<string, number | string>;
    /** The group the player has selected, for a `selection` subject. */
    selection?: { groupId: number };
    /** Omit the `unitClass` port, to exercise the honest "I can't tell which
     *  squads are tanks yet" refusal that the live client hits today. */
    noUnitClass?: boolean;
    /** Omit the `groupPosition` port, so nearest-to-target is skipped. */
    noGroupPosition?: boolean;
}

/** Test-side expectations that go beyond the envelope itself. The required trio
 *  is `{utterance, context, expected}`; this is what the EXECUTOR should do with
 *  `expected`, which no amount of schema-checking can imply. */
export interface FixtureExpect {
    /** `type` (and, for directives, `groupId`) of each `sendCommand` call, in
     *  order. An empty array asserts nothing was sent. */
    sends?: Array<{ type: string; groupId?: number; wire?: string }>;
    /** Exact worker-facing camera calls, in order — `focusOn:x,z` (rounded),
     *  `fitMap`, `orbit:<distance>`, `snapToUnit:<id>`, `saveView:<n>`. A follow
     *  shows up as its first `focusOn`; use `following` for the mode itself. */
    camera?: string[];
    /** The label the camera is following after the run, or null for "not
     *  following". Absent ⇒ not asserted. */
    following?: string | null;
    /** Exact registry calls, in order — `open:parley-panel`, `fullscreen:minimap`. */
    ui?: string[];
    /** The executor must ask rather than act. */
    clarifies?: boolean;
    /** The question's own shape: the chips offered, how many the answer takes,
     *  and whether the console can answer it without the model (M5). */
    asks?: { options?: string[]; pick?: number; patchable?: boolean };
    /** How many refusal lines the run produced. */
    refusals?: number;
    /** Short labels of the actions that completed, in order (M5). */
    ran?: string[];
    /** Short labels of the actions the stop skipped (M5). An empty array
     *  asserts the plan ran to the end. */
    notRun?: string[];
    /** Substrings that must appear somewhere in the printed lines. */
    saysLike?: string[];
}

export interface NLFixture {
    name: string;
    utterance: string;
    /** Key into `contexts.json`. */
    context: string;
    expected: NLResponse;
    expect?: FixtureExpect;
    /**
     * Prior exchanges, oldest first, alternating you/game — the `history` the
     * proxy accepts (§3, ≤2). Present on the second half of a clarification
     * round-trip, where the question the game asked is what makes the follow-up
     * sentence mean anything.
     *
     * The TS suites ignore it (they execute `expected`, which is already the
     * answer); `tools/nl-eval` sends it, because whether the MODEL can carry a
     * round-trip is exactly what the eval measures.
     */
    history?: string[];
    /**
     * Run this fixture with the M3 camera / registry / query ports injected.
     *
     * Default false, and deliberately so: the M1 fixtures assert that a camera or
     * query envelope refuses BY NAME when no port is wired, which is still the
     * live behaviour of any surface that hasn't installed them (a spectator HUD,
     * a headless harness). Both states are real and both are covered.
     */
    ports?: boolean;
    /** Why this fixture exists, when that isn't obvious from the utterance. */
    note?: string;
}

export interface FixtureFile {
    _comment?: string;
    fixtures: NLFixture[];
}

// ─────────────────────────── the world ───────────────────────────

export interface FixtureWorld {
    index: NamedEntityIndex;
    groups: OrgGroupSummary[];
    resolver: NLResolver;
    deps: ResolverDeps;
    /** The LOS-filtered mirror this board exposes, or null under `noCensus`. */
    census: Census | null;
    /** Every `CameraPort` call the fixture made, in order (see FixtureExpect). */
    cameraCalls: string[];
    /** Every registry call, in order. */
    uiCalls: string[];
    /** The live port, so a test can read `followingLabel()` and — importantly —
     *  `dispose()` the follow interval a fixture may have started. */
    cameraPort: CameraPort;
    /** The real M3 ports, built over this board. Fakes only where a fake is the
     *  honest choice: the camera port records worker calls instead of posting
     *  them (there is no worker), while the registry and the query engine are the
     *  SHIPPING classes — a fixture asserting a hand-written query answer would
     *  prove the fixture, not the engine. */
    ports: {
        camera: ReturnType<typeof createNLCameraPort>;
        uiActions: ReturnType<typeof createNLUiActionPort>;
        queryEngine: QueryEngine;
    };
}

/** Panels every board has unless it says otherwise — the Metalstorm manifest set
 *  plus the minimap, which is the one entry with a full-screen mode. */
const DEFAULT_PANELS: NonNullable<FixtureContext['panels']> = [
    { id: 'minimap', label: 'Minimap', aliases: ['mini map', 'tactical map'], fullscreen: true },
    { id: 'parley-panel', label: 'Parley', aliases: ['diplomacy panel', 'diplomacy'] },
    { id: 'objectives-panel', label: 'Objectives', aliases: ['objectives', 'mission'] },
    { id: 'scoreboard-panel', label: 'Scoreboard', aliases: ['scores'] },
    { id: 'ai-command-panel', label: 'AI Command', aliases: ['ai panel', 'guidance'] },
];

function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Member unit ids for a fixture group — `<groupId>*1000 + n`, so a unit id
 *  identifies its group on sight when a test needs to read one. */
function memberIds(group: FixtureGroup): number[] {
    const total = group.size + (group.attach?.n ?? 0);
    return Array.from({ length: total }, (_, i) => group.id * 1000 + i);
}

export function buildFixtureWorld(context: FixtureContext, vocabulary: ClassVocabulary): FixtureWorld {
    const entities: NamedEntity[] = [];

    // Landmarks take the long way round on purpose. Every other place in a
    // fixture is a hand-built `NamedEntity`, which is fine because its producer
    // is landed and covered elsewhere; landmarks have NO publisher yet (that is
    // the scenario-gen lane's), so a hand-built one would prove only that the
    // fixture builder works. Instead the fixture synthesizes the
    // `landmark_<key>_x/_z/_name` rulesParams a publisher would emit and runs
    // them through the REAL parser — so "escort the grain silo" is evidence
    // about the wire shape the day something starts publishing it.
    const landmarkParams = new Map<string, number | string>();
    for (const place of context.places ?? []) {
        if (place.t === 'landmark') {
            const key = place.k ?? slug(place.n);
            landmarkParams.set(`landmark_${key}_x`, place.x);
            landmarkParams.set(`landmark_${key}_z`, place.z);
            landmarkParams.set(`landmark_${key}_name`, place.n);
            continue;
        }
        entities.push({ id: place.k ?? slug(place.n), type: place.t, name: place.n, x: place.x, z: place.z });
    }
    entities.push(...parseLandmarksFromRulesParams(landmarkParams));
    for (const objective of context.objectives ?? []) {
        entities.push({ id: objective.id, type: 'objective', name: objective.n, x: objective.x, z: objective.z });
    }

    const groups: OrgGroupSummary[] = (context.groups ?? []).map((g) => ({
        groupId: g.id,
        echelon: g.echelon ?? 'Squad',
        ownerTeam: 0,
        parentId: 0,
        name: g.n,
        memberIds: memberIds(g),
        // The store's own "0 = none assigned" convention IS the idle test (§5
        // "no active directive"); a fixture says `busy: true` and gets an id.
        currentDirectiveId: g.busy ? 100 + g.id : 0,
        postureJson: '',
        baseCostSum: g.size * 10,
    }));

    // Groups go in the index as SUBJECTS with x/z 0, exactly as the live
    // producer stores them (entity-index-producer.ts: `gp:orgGroups` carries no
    // centroid). Group positions come from the separate `groupPosition` port —
    // if a fixture could rank by the index's zeroes it would be testing a bug.
    for (const g of context.groups ?? []) {
        const type: EntityType = g.echelon === 'Platoon' ? 'platoon' : g.echelon === 'Army' ? 'army' : 'group';
        entities.push({ id: g.id, type, name: g.n, x: 0, z: 0 });
    }

    const index = new NamedEntityIndex();
    index.replaceAll(entities);

    // unit id → ms_class/ms_scale, built from the same synthesized rosters.
    const classByUnit = new Map<number, { className: string; scale?: number }>();
    for (const g of context.groups ?? []) {
        // A fixture whose "attached" minority outnumbers its stated class would
        // be asserting a dominant class the resolver correctly disagrees with —
        // catch the fixture bug here rather than debugging a mystery failure.
        if ((g.attach?.n ?? 0) >= g.size) {
            throw new Error(`fixture group "${g.n}": attached members are not a minority`);
        }
        memberIds(g).forEach((unitId, i) => {
            classByUnit.set(unitId, i < g.size
                ? { className: g.cls, scale: g.scale }
                : { className: g.attach!.cls, scale: g.attach!.scale });
        });
    }

    const positionByGroup = new Map<number, { x: number; z: number }>();
    for (const g of context.groups ?? []) {
        if (typeof g.x === 'number' && typeof g.z === 'number') positionByGroup.set(g.id, { x: g.x, z: g.z });
    }

    const deps: ResolverDeps = {
        index,
        vocabulary,
        groups,
        selectionGroupId: context.selection?.groupId ?? null,
        ...(context.noUnitClass ? {} : { unitClass: (unitId: number) => classByUnit.get(unitId) }),
        ...(context.noGroupPosition ? {} : { groupPosition: (groupId: number) => positionByGroup.get(groupId) }),
    };
    const resolver = new NLResolver(deps);

    // ── the LOS-filtered mirror ──
    //
    // Own group members go in automatically at their group's stated position: a
    // squad you command is in your own stream by definition, and a fixture
    // shouldn't have to restate eight tank ids to ask where its squad is.
    // Everything else — enemies, allies, loose units — is listed explicitly, and
    // an enemy the fixture DOESN'T list is an enemy out of LOS.
    const censusUnits: CensusUnit[] = [];
    for (const g of context.groups ?? []) {
        const at = positionByGroup.get(g.id) ?? { x: 0, z: 0 };
        memberIds(g).forEach((unitId, i) => {
            const info = i < g.size
                ? { className: g.cls, scale: g.scale }
                : { className: g.attach!.cls, scale: g.attach!.scale };
            censusUnits.push({
                unitId, team: 0, side: 'own',
                className: info.className,
                ...(info.scale !== undefined ? { scale: info.scale } : {}),
                // Spread members a few elmos apart so a centroid is a real
                // average rather than an identical point repeated.
                x: at.x + (i % 4) * 8,
                z: at.z + Math.floor(i / 4) * 8,
            });
        });
    }
    let syntheticId = 900000;
    for (const u of context.visible ?? []) {
        censusUnits.push({
            unitId: u.id ?? syntheticId++,
            team: u.side === 'own' ? 0 : u.side === 'ally' ? 1 : 2,
            side: u.side,
            className: u.cls,
            ...(u.scale !== undefined ? { scale: u.scale } : {}),
            x: u.x, z: u.z,
        });
    }
    const census: Census | null = context.noCensus
        ? null
        : { frame: 1200, myTeam: 0, units: censusUnits };

    const censusPort: CensusPort = { snapshot: () => census };

    // ── the ports, over this board ──
    const cameraCalls: string[] = [];
    const uiCalls: string[] = [];

    const registry = new UiActionRegistry();
    for (const panel of context.panels ?? DEFAULT_PANELS) {
        let open = true;
        let full = false;
        registry.register({
            id: panel.id,
            label: panel.label,
            aliases: panel.aliases ?? [],
            open: () => { uiCalls.push(`open:${panel.id}`); open = true; },
            close: () => { uiCalls.push(`close:${panel.id}`); open = false; full = false; },
            toggle: () => { uiCalls.push(`toggle:${panel.id}`); open = !open; },
            isOpen: () => open,
            ...(panel.fullscreen ? {
                fullscreen: (on?: boolean) => {
                    uiCalls.push(`fullscreen:${panel.id}`);
                    full = on ?? !full;
                    return full;
                },
            } : {}),
        });
    }

    // A CameraPort over a recording worker channel: the framing decisions (which
    // op, which coordinates) are the REAL ones — only the postMessage is faked,
    // because a fixture has no worker.
    const cameraPort = new CameraPort({
        call: (method, args) => cameraCalls.push(describeCameraCall(method, args)),
        pose: () => ({ pos: { x: 0, y: 800, z: -800 }, lookAt: { x: 0, y: 0, z: 0 } }),
    });

    const groupPosition = (groupId: number): { x: number; z: number } | null => {
        const group = groups.find((g) => g.groupId === groupId);
        if (!group || !census) return null;
        const members = new Set(group.memberIds);
        const seen = census.units.filter((u) => members.has(u.unitId));
        if (seen.length === 0) return null;
        return {
            x: seen.reduce((s, u) => s + u.x, 0) / seen.length,
            z: seen.reduce((s, u) => s + u.z, 0) / seen.length,
        };
    };

    const gameRulesParams = context.gameRulesParams ?? {};
    const teamRulesParams = context.teamRulesParams ?? {};

    const ports = {
        camera: createNLCameraPort({ port: cameraPort, resolver, groupPosition }),
        uiActions: createNLUiActionPort(registry),
        queryEngine: new QueryEngine({
            census: censusPort,
            index,
            vocabulary,
            resolveEntity: (name, opts) => resolver.resolveEntity(name, opts),
            groups,
            directives: [],
            gameRulesParam: (key) => gameRulesParams[key],
            teamRulesParam: (key) => teamRulesParams[key],
            playerId: 0,
            focusCamera: (x, z) => cameraPort.focusOn(x, z),
        }),
    };

    return { index, groups, deps, resolver, census, cameraCalls, uiCalls, cameraPort, ports };
}

/** `focusOn:1000,1000` — coordinates rounded, because a fixture asserting a
 *  centroid to fifteen decimal places is asserting floating-point arithmetic. */
function describeCameraCall(method: string, args?: unknown[]): string {
    const a = args ?? [];
    if (method === 'focusOn') return `focusOn:${Math.round(Number(a[0]))},${Math.round(Number(a[1]))}`;
    if (method === 'cameraFitMap') return 'fitMap';
    if (method === 'cameraSnapToUnit') return `snapToUnit:${a[0]}`;
    if (method === 'cameraOrbit') return `orbit:${Math.round(Number((a[0] as { distance?: number })?.distance ?? 0))}`;
    if (method === 'cameraSaveSlot') return `saveView:${a[0]}`;
    if (method === 'cameraLoadSlot') return `loadView:${a[0]}`;
    return method;
}
