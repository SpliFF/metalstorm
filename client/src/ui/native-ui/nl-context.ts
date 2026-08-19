/**
 * nl-context.ts — the context payload the proxy sends with every utterance
 * (PLAN-metalstorm-command-language.md §2, milestone M4)
 *
 * This is the model's entire view of the game. Everything it is allowed to
 * name comes from here, and the prompt's first rule ("never invent a name") is
 * only enforceable because this payload is the closed world it is checked
 * against.
 *
 * Three properties, each load-bearing:
 *
 * **LOS-honest by construction.** Every source below is a team-scoped stream —
 * the census only ever contains enemies the server has already decided this
 * team can see, the index is built from this team's rulesParams. There is no
 * filtering step here that could be forgotten, because there is nothing
 * unfiltered to filter. An enemy group named in this payload is an enemy group
 * the player could point at on screen.
 *
 * **Names only, never ids.** The envelope that comes back is name-addressed
 * (§1), and `nl-resolver.ts` turns names into ids under rules the local path
 * uses too. Shipping ids here would let the model return one, and an id the
 * resolver never vetted is an order that skips ambiguity handling entirely.
 *
 * **Deterministic.** Sorted, truncated at a fixed size, no timestamps, no
 * frame numbers. Two identical board states produce byte-identical payloads,
 * which is what makes the golden fixtures in `nl-fixtures/` diffable and what
 * stops the payload from being a source of noise when comparing eval runs.
 *
 * Size target is ~1.5k tokens (§2). The caps below are what hold it there on a
 * big late-game board; a map with 400 named places sends the 60 that matter.
 */

import type { ClassVocabulary } from './class-vocabulary.js';
import type { Census } from './query-engine.js';
import type { NamedEntity, EntityType } from './named-entity-index.js';
import type { OrgGroupSummary, DirectiveSummary } from './ui-store.js';

// ───────────────────────────────── the shape ───────────────────────────────

export interface NLContextPlace {
    /** The name, exactly as the index holds it. */
    n: string;
    /** `region` | `district` | `city` | `landmark` — what kind of place it is. */
    t: string;
}

export interface NLContextGroup {
    n: string;
    /** Dominant member `ms_class`, omitted when the group has no members on
     *  the field (a group that exists but has nothing in it). */
    cls?: string;
    /** Member count. */
    sz: number;
    /** `idle` or `tasked` — the single distinction the resolver's idle-first
     *  ranking turns on, so the model can prefer the same group it would. */
    state: 'idle' | 'tasked';
}

export interface NLContextSelf {
    /** How many units are selected right now. 0 ⇒ `selection` subjects are a
     *  mistake, and the model can see that before making one. */
    selection: number;
    /** Spendable authority, or omitted when the rulesParam is absent. */
    authority?: number;
    /** Own-unit counts by class, so "how many tanks" and "send half the
     *  tanks" are answerable without a round trip. */
    counts: Record<string, number>;
}

export interface NLContext {
    /**
     * Omitted entirely when the client does not know the map's name.
     *
     * It genuinely does not today: `WidgetContext` carries identity, store and
     * sendCommand, and the map name lives on the Lua host's `Game.mapName`
     * with no native-side path to it. Rather than plumb one through for a
     * cosmetic field, this is absent — the model navigates by the `places`
     * list, which is the part that actually resolves. `sectors` waits on the
     * grid-provider naming in §5.
     */
    map?: { name: string; sectors?: string };
    places: NLContextPlace[];
    groups: NLContextGroup[];
    enemies: { n: string }[];
    objectives: string[];
    /**
     * The classes the player ACTUALLY HAS on the field, not the whole
     * vocabulary.
     *
     * §2 lists a `classes` field, and the obvious reading is "the class table".
     * That table is already in the proxy's system prompt, where it is cached
     * across every request in the match — repeating all ~40 classes here would
     * pay full price for it on every single utterance and tell the model
     * nothing it did not already know. What it does NOT know from the cached
     * table is which of those classes exist in this game right now, and that is
     * the part that changes what a sentence means: "send the armour" is an
     * order when there are tanks and a refusal when there are not.
     */
    classes: string[];
    /** Panel ids a `ui` action may name. */
    panels: string[];
    self: NLContextSelf;
}

// ─────────────────────────────────── caps ──────────────────────────────────

/** §2: "truncate places to the ~60 most relevant on huge maps". */
export const MAX_PLACES = 60;
/** A player with more than this many groups is not going to name one of the
 *  others in a sentence, and every extra line costs tokens on every request. */
export const MAX_GROUPS = 40;
export const MAX_ENEMIES = 20;
export const MAX_OBJECTIVES = 12;

/** Index types that are places a player would say the name of. */
const PLACE_TYPES: readonly EntityType[] = ['city', 'district', 'region', 'landmark'];
/** Index types that are org groups. */
const GROUP_TYPES: readonly EntityType[] = ['group', 'platoon', 'army'];

export interface BuildContextDeps {
    index: { getAll(): NamedEntity[]; getByType(type: EntityType): NamedEntity[] };
    census: { snapshot(): Census | null };
    vocabulary: ClassVocabulary;
    groups: readonly OrgGroupSummary[];
    directives: readonly DirectiveSummary[];
    /** Registered panel ids (`uiActionRegistry.ids()`). */
    panelIds: readonly string[];
    /** How many units the player has selected. */
    selectionCount: number;
    /** Omitted when unknown — see `NLContext.map`. */
    mapName?: string;
    /** Spendable authority, when the rulesParam is readable. */
    authority?: number;
}

/**
 * Build the payload.
 *
 * Pure and synchronous: it reads snapshots the caller already refreshed (the
 * console awaits the census once, before the whole run — see
 * `command-console.js`) and never awaits anything itself. That keeps the
 * "one utterance sees one board" property the executor depends on.
 */
export function buildNLContext(deps: BuildContextDeps): NLContext {
    const census = deps.census.snapshot();
    const own = (census?.units ?? []).filter((u) => u.side === 'own');

    // ── counts + the classes actually present ──
    const counts: Record<string, number> = {};
    for (const u of own) {
        if (!u.className) continue;
        counts[u.className] = (counts[u.className] ?? 0) + 1;
    }
    const classes = Object.keys(counts).sort();

    // ── groups ──
    // The index and the store hold two halves: the store knows membership and
    // whether a directive is attached, the census knows what the members ARE.
    const unitsById = new Map(own.map((u) => [u.unitId, u]));
    const groups: NLContextGroup[] = deps.groups
        .map((g): NLContextGroup => {
            const memberClasses: Record<string, number> = {};
            for (const id of g.memberIds) {
                const cls = unitsById.get(id)?.className;
                if (cls) memberClasses[cls] = (memberClasses[cls] ?? 0) + 1;
            }
            // Dominant class, ties broken by name so the payload is stable.
            const dominant = Object.entries(memberClasses)
                .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))[0]?.[0];
            return {
                n: g.name,
                ...(dominant ? { cls: dominant } : {}),
                sz: g.memberIds.length,
                state: g.currentDirectiveId > 0 ? 'tasked' : 'idle',
            };
        })
        .filter((g) => g.n.trim().length > 0)
        .sort((a, b) => a.n.localeCompare(b.n))
        .slice(0, MAX_GROUPS);

    // ── places ──
    const placeEntities = PLACE_TYPES.flatMap((t) => deps.index.getByType(t));
    const places = rankPlaces(placeEntities, own)
        .slice(0, MAX_PLACES)
        .map((e): NLContextPlace => ({ n: e.name, t: e.type }))
        .sort((a, b) => a.n.localeCompare(b.n));

    // ── enemies ──
    // `enemy-force` entries are the macro-intel stream's own summaries ("enemy
    // armour near Osprey Fen"). Absent until that producer lands (§6.5), and
    // an empty list is the honest answer meanwhile — better than synthesising
    // enemy names out of raw census units, which would hand the model
    // "entities" the resolver has never heard of and cannot look up.
    const enemies = deps.index.getByType('enemy-force')
        .map((e) => ({ n: e.name }))
        .sort((a, b) => a.n.localeCompare(b.n))
        .slice(0, MAX_ENEMIES);

    // ── objectives ──
    const objectives = deps.index.getByType('objective')
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_OBJECTIVES);

    const self: NLContextSelf = {
        selection: deps.selectionCount,
        ...(deps.authority !== undefined && Number.isFinite(deps.authority)
            ? { authority: Math.round(deps.authority) }
            : {}),
        counts,
    };

    // Group types are in the index too, but the store is the better source for
    // them (it has membership and directive state), so the index's copies are
    // deliberately not merged in — one group must not appear twice under two
    // spellings of the same name.
    void GROUP_TYPES;

    return {
        ...(deps.mapName ? { map: { name: deps.mapName } } : {}),
        places,
        groups,
        enemies,
        objectives,
        classes,
        panels: [...deps.panelIds].sort(),
        self,
    };
}

/**
 * Order places most-relevant-first for the truncation cut.
 *
 * "Relevant" = near the player's own forces. A 400-place generated map is
 * mostly places the player has never been to and will not name; the ones they
 * WILL name are the ones they are standing in or heading toward. Cities and
 * districts outrank bare regions at equal distance, because an authored name
 * is more likely to be said out loud than "Sector B9".
 *
 * With no units on the field (pre-spawn, spectator) it degrades to a stable
 * name sort rather than an arbitrary one — the payload must not depend on
 * index insertion order.
 */
function rankPlaces(
    places: readonly NamedEntity[],
    own: readonly { x: number; z: number }[],
): NamedEntity[] {
    const named = places.filter((p) => p.name && p.name.trim().length > 0);
    if (named.length <= MAX_PLACES) {
        return [...named].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (own.length === 0) {
        return [...named].sort((a, b) => a.name.localeCompare(b.name));
    }

    let cx = 0;
    let cz = 0;
    for (const u of own) { cx += u.x; cz += u.z; }
    cx /= own.length;
    cz /= own.length;

    const rank = (p: NamedEntity): number => {
        const dx = p.x - cx;
        const dz = p.z - cz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        // Authored places get a flat discount rather than a multiplier, so a
        // city on the far side of the map still loses to a region underfoot.
        const bonus = (p.type === 'city' || p.type === 'district') ? 2048 : 0;
        return dist - bonus;
    };

    return [...named].sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name));
}
