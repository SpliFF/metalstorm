/**
 * reveal-predicate.ts — `revealOn` progressive-disclosure predicates
 * (PLAN-native-ui.md §3, PLAN-metalstorm-onboarding.md §5)
 *
 * A manifest entry may carry `revealOn: "<predicate>"`. The loader keeps that
 * widget unmounted until the predicate first evaluates true, then mounts it and
 * stops watching — disclosure is **one-way** (a panel that has appeared never
 * vanishes again, which would be far more disorienting than showing it early).
 *
 * Predicates are *pure reads of the ui-store*. They are deliberately a tiny
 * fixed grammar rather than `eval` of game-supplied JS: the manifest is fetched
 * over HTTP from the game dir, so an expression evaluator here would be a
 * remote-code-execution surface for anything that can serve a manifest. (Game
 * *widgets* do run with page privileges — see PLAN-native-ui.md §3's security
 * note — but that is an explicit, reviewable `<script>`-equivalent decision;
 * the manifest is data and stays data.)
 *
 * Grammar (v1):
 *
 *     predicate  := clause ( "&&" clause )*
 *     clause     := flag | comparison
 *     flag       := "hasSelection" | "hasOrgGroups" | "hasDirectives"
 *     comparison := source op number
 *     source     := "game:" KEY        -- game rules param
 *                 | "team:" KEY        -- local player's team rules param
 *                 | "selection.count" | "orgGroups.count" | "directives.count"
 *     op         := ">=" | "<=" | "==" | "!=" | ">" | "<"
 *
 * Examples, covering every case the two consuming plans name:
 *
 *     "hasSelection"                        PLAN-native-ui §3
 *     "team:authority_pool > 0"             PLAN-native-ui §3 ("authority>0")
 *     "game:objectives_completed >= 1"      PLAN-native-ui §3 ("objective:first-complete")
 *     "team:parley_incoming >= 1"           onboarding §5 (parley panel)
 *     "team:ai_teammates > 0"               onboarding §5 (guidance panel)
 *     "game:score_events >= 1"              onboarding §5 (scoreboard)
 *     "hasOrgGroups && team:authority_pool > 0"
 *
 * Deliberately absent: `||`, negation, parentheses, string comparison. Add them
 * when a real manifest needs one — an unused operator is an untested operator.
 */

import type { UIStore } from './ui-store.js';

/** Store paths the predicate reads — the loader subscribes to exactly these. */
export type RevealStorePath =
    | 'gameRulesParams'
    | 'teamRulesParams'
    | 'selection'
    | 'orgGroups'
    | 'directives';

export interface RevealIdentity {
    playerId: number;
    teamId: number;
}

export interface RevealPredicate {
    /** Original source text, for diagnostics. */
    readonly source: string;
    /** Distinct store paths this predicate depends on. */
    readonly paths: readonly RevealStorePath[];
    test(store: UIStore, identity: RevealIdentity): boolean;
}

type Comparator = '>=' | '<=' | '==' | '!=' | '>' | '<';

/** Longest-first: `>` would otherwise shadow `>=`. */
const COMPARATORS: Comparator[] = ['>=', '<=', '==', '!=', '>', '<'];

interface Clause {
    paths: RevealStorePath[];
    test(store: UIStore, identity: RevealIdentity): boolean;
}

/** Numeric sources that read a count off the store rather than a rules param. */
const COUNT_SOURCES: Record<string, { path: RevealStorePath; read: (s: UIStore, i: RevealIdentity) => number }> = {
    'selection.count': { path: 'selection', read: (s) => s.getSelection().unitIds.length },
    'orgGroups.count': { path: 'orgGroups', read: (s) => s.getOrgGroups().length },
    'directives.count': { path: 'directives', read: (s) => s.getDirectives().length },
};

/** Bare boolean flags — sugar for the `.count > 0` form. */
const FLAGS: Record<string, { path: RevealStorePath; read: (s: UIStore, i: RevealIdentity) => boolean }> = {
    hasSelection: { path: 'selection', read: (s) => s.getSelection().unitIds.length > 0 },
    hasOrgGroups: { path: 'orgGroups', read: (s) => s.getOrgGroups().length > 0 },
    hasDirectives: { path: 'directives', read: (s) => s.getDirectives().length > 0 },
};

function compare(lhs: number, op: Comparator, rhs: number): boolean {
    switch (op) {
        case '>=': return lhs >= rhs;
        case '<=': return lhs <= rhs;
        case '==': return lhs === rhs;
        case '!=': return lhs !== rhs;
        case '>':  return lhs > rhs;
        case '<':  return lhs < rhs;
    }
}

/**
 * Read a numeric source. A rules param that is absent, or present as a
 * non-numeric string, reads as **absent** rather than 0 — otherwise
 * `team:authority_pool <= 0` would fire before the first rules-param batch
 * has even arrived, revealing every widget it was supposed to gate.
 */
function readSource(
    source: string,
    store: UIStore,
    identity: RevealIdentity,
): number | undefined {
    const count = COUNT_SOURCES[source];
    if (count) return count.read(store, identity);

    let raw: number | string | undefined;
    if (source.startsWith('game:')) {
        raw = store.gameRulesParam(source.slice(5));
    } else if (source.startsWith('team:')) {
        raw = store.teamRulesParam(identity.teamId, source.slice(5));
    } else {
        return undefined;
    }

    if (raw === undefined) return undefined;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function sourcePath(source: string): RevealStorePath | null {
    const count = COUNT_SOURCES[source];
    if (count) return count.path;
    if (source.startsWith('game:')) return 'gameRulesParams';
    if (source.startsWith('team:')) return 'teamRulesParams';
    return null;
}

function parseClause(text: string): Clause | null {
    const src = text.trim();
    if (!src) return null;

    const flag = FLAGS[src];
    if (flag) {
        return { paths: [flag.path], test: (s, i) => flag.read(s, i) };
    }

    for (const op of COMPARATORS) {
        const at = src.indexOf(op);
        if (at < 0) continue;
        const source = src.slice(0, at).trim();
        const rhsText = src.slice(at + op.length).trim();
        const rhs = Number(rhsText);
        if (!source || rhsText === '' || !Number.isFinite(rhs)) return null;

        const path = sourcePath(source);
        if (!path) return null;

        return {
            paths: [path],
            test: (s, i) => {
                const lhs = readSource(source, s, i);
                return lhs === undefined ? false : compare(lhs, op, rhs);
            },
        };
    }

    return null;
}

/**
 * Parse a `revealOn` string. Returns null on any malformed input — the caller
 * (widget-loader) treats a null as "mount immediately, and warn": a typo in a
 * game manifest must not make a panel permanently unreachable, which is the
 * failure mode a player cannot diagnose or work around.
 */
export function parseRevealPredicate(source: string): RevealPredicate | null {
    const clauses: Clause[] = [];
    for (const part of source.split('&&')) {
        const clause = parseClause(part);
        if (!clause) return null;
        clauses.push(clause);
    }
    if (clauses.length === 0) return null;

    const paths = Array.from(new Set(clauses.flatMap(c => c.paths)));
    return {
        source,
        paths,
        test: (store, identity) => clauses.every(c => c.test(store, identity)),
    };
}
