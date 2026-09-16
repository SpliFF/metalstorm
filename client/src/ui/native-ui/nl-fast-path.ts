/**
 * nl-fast-path.ts — the deterministic parse that never asks the model
 * (PLAN-metalstorm-command-language.md §3 "Degradation", 2026-09-10 review)
 *
 * `nl-client.ts` already has an offline producer. This is NOT a second one: the
 * offline parser is a FALLBACK — it runs when the proxy is unavailable, and it
 * is allowed to be approximate because the alternative at that moment is
 * nothing at all. This file is the opposite trade. It runs while the proxy is
 * perfectly healthy, BEFORE the round trip, and it is allowed to claim a
 * sentence only when the reading is beyond argument:
 *
 *   - one clause, no conjunction, no priority word, no when-gate;
 *   - a verb from a CLOSED synonym list, at the front;
 *   - every name in it an EXACT (case-folded) hit in the entity index — never a
 *     prefix, never a substring, never a fuzzy score;
 *   - or no target word at all, with the focus supplying one (a drilled place,
 *     or `withdraw`'s departure zone);
 *   - and a DRY RESOLVE that comes back `ok` for both subject and target.
 *
 * Anything else — a clarify, a refusal, an unclaimed word, a question already
 * on screen — stands aside and the sentence goes to the model exactly as
 * before. That asymmetry is the whole safety argument: this layer can only ever
 * REMOVE a round trip from a sentence whose meaning the resolver has already
 * agreed with, so a bug here costs latency, never a moved army. A sentence it
 * declines is not refused; it is simply not claimed.
 *
 * It reads the CURRENT FOCUS through the same port everything else does
 * (`nl-focus.ts`, `bindFocusReferences`). There is deliberately no state in
 * this file: a fast path with its own idea of what is selected is the
 * wrong-army failure wearing a stopwatch.
 */

import type { CommandVerb } from './compile-table.js';
import type { NLResponse, NLSubject, NLTarget } from './nl-envelope.js';
import type { NLFocusView } from './focus-model.js';
import {
    bindFocusReferences, findSubjectDeictic, type NLFocusSnapshot, focusViewFrom,
} from './nl-focus.js';
import type { NLResolver, ResolverIndex } from './nl-resolver.js';
import type { EntityType } from './named-entity-index.js';

/** Why a sentence was claimed — reported so the eval can measure absorption
 *  per rule rather than as one undifferentiated percentage. */
export type FastPathRule =
    | 'verb-name'            // "attack Northgate"
    | 'verb-name-to-name'    // "withdraw Chimera Squad to Osprey Fen"
    | 'verb-elided'          // "attack" with a town drilled
    | 'withdraw-departure';  // "pull back" with a departure zone on the map

export interface FastPathClaim {
    /** The envelope, already focus-BOUND — the same object the proxy path
     *  would have handed to `deliver`, so nothing downstream can tell the
     *  difference except that it arrived in zero milliseconds. */
    response: NLResponse;
    rule: FastPathRule;
    /** True when the focus supplied a slot the sentence left empty. The caller
     *  still owes the player a confirmation for those (U4) — this does NOT
     *  bypass the confirm gate, it bypasses the network. */
    usedFocus: boolean;
}

export interface FastPathDeps {
    resolver: NLResolver;
    /** The entity index, for the exact-name test. Same object the resolver
     *  holds; passed explicitly so this file never reaches through the
     *  resolver's privates. */
    index: ResolverIndex;
    /** The drilldown focus port — a `FocusModel`, a `lib/focus.js` store, a
     *  snapshot or the wire shape. `focusViewFrom` feature-detects it. */
    focus?: NLFocusView | NLFocusSnapshot | unknown;
    /**
     * The selected group, when the surface has one and no focus snapshot
     * (`uiStore`-only callers, and every board in the fixture world that
     * predates the focus contract). Read for exactly one decision — whether an
     * unqualified order means `selection` or `any` — and never as a second
     * source of truth about the focus: when both are present the focus wins,
     * because it is the thing the player is looking at.
     */
    selectionGroupId?: number | null;
}

// ─────────────────────────── the closed grammar ───────────────────────────

/**
 * Verb synonyms. Closed, and deliberately SMALL: every entry here is a word
 * whose mapping no reasonable player would dispute. "clear", "deal with",
 * "handle" and their friends are absent on purpose — they are exactly the
 * sentences worth spending a model call on.
 *
 * Multi-word entries are matched longest-first (see `matchVerb`), so "pull
 * back" is never read as a bare "pull".
 */
const VERB_SYNONYMS: Readonly<Record<string, CommandVerb>> = {
    attack: 'attack', hit: 'attack', engage: 'attack', assault: 'attack', strike: 'attack',
    secure: 'secure', capture: 'secure', seize: 'secure', take: 'secure',
    defend: 'defend', guard: 'defend', protect: 'defend',
    hold: 'hold', garrison: 'hold',
    patrol: 'patrol', sweep: 'patrol',
    screen: 'screen',
    scout: 'scout', recon: 'scout', reconnoitre: 'scout', reconnoiter: 'scout', probe: 'scout',
    escort: 'escort',
    withdraw: 'withdraw', retreat: 'withdraw',
    'pull back': 'withdraw', 'fall back': 'withdraw', 'pull out': 'withdraw',
    reinforce: 'reinforce', bolster: 'reinforce',
    build: 'build',
};

/** Longest first, so "pull back" wins over nothing and "fall back" over none. */
const VERB_PHRASES = Object.keys(VERB_SYNONYMS)
    .sort((a, b) => b.length - a.length);

/** Words the grammar may skip between slots. Anything NOT here is an unclaimed
 *  word, and an unclaimed word means stand aside. */
const SKIPPABLE = new Set(['the', 'a', 'an', 'to', 'at', 'on', 'in', 'into', 'onto',
    'toward', 'towards', 'over', 'up', 'our', 'my', 'please', 'now']);

/** Connectors that make a sentence more than one order. Present ⇒ stand aside
 *  and let the model order the steps (§1 "multi-step = ordered list"). */
const CONNECTOR = /(?:^|\s)(?:and|then|after|before|while|but|;|,)(?:\s|$)/i;

/** Anything that carries a priority band or a when-gate. The fast path parses
 *  neither, and a sentence whose urgency it silently dropped would be a
 *  different order. */
const MODIFIER = /\b(?:urgent|urgently|priority|low|normal|high|when|if|unless|once|asap|immediately)\b/i;

/** The prepositions a two-name sentence may hinge on. */
const HINGES = [' to ', ' at ', ' on ', ' into ', ' onto ', ' toward ', ' towards '];

const PLACE_TYPES: EntityType[] = [
    'region', 'district', 'city', 'objective', 'landmark', 'enemy-force',
];
const FORCE_TYPES: EntityType[] = ['group', 'platoon', 'army'];

// ─────────────────────────────── the parse ───────────────────────────────

/**
 * Claim `utterance`, or return null to let it go to the model.
 *
 * Null is not a refusal and must never be rendered as one. The caller's
 * contract is: null ⇒ carry on exactly as if this function did not exist.
 */
export function fastPathParse(
    utterance: string, deps: FastPathDeps,
): FastPathClaim | null {
    const focus = focusViewFrom(deps.focus) ?? null;

    // A question is on screen. A typed line now is probably its ANSWER, and
    // `nl-clarify.ts` owns that path; claiming it here would answer the wrong
    // question very quickly.
    if (focus?.asked) return null;

    const text = utterance.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
    if (!text) return null;
    if (CONNECTOR.test(text)) return null;
    if (MODIFIER.test(text)) return null;

    const verb = matchVerb(text);
    if (!verb) return null;

    const rest = text.slice(verb.phrase.length).trim();
    const built = buildIntent(verb.verb, rest, focus, deps, text);
    if (!built) return null;

    const envelope: NLResponse = {
        actions: [{ kind: 'command', intent: { verb: verb.verb, ...built.slots } }],
    };

    // The same binder the proxy path runs, for the same reason: an elided
    // target is a focus reading, and there is exactly one of those in the
    // codebase.
    const bound = bindFocusReferences(envelope, focus);
    const action = bound.response.actions[0];
    if (!action || action.kind !== 'command') return null;

    // The dry resolve. Both slots must come back `ok` — a clarify means the
    // sentence was ambiguous after all, and a refusal means the model may know
    // something the grammar doesn't (a guidance reading, a query, a better
    // refusal in its own words).
    const subject = deps.resolver.resolveSingleSubject(action.intent.subject);
    if (subject.kind !== 'ok') return null;
    const target = deps.resolver.resolveTarget(
        action.intent.verb, action.intent.target, action.intent.subject);
    if (target.kind !== 'ok') return null;

    return {
        response: bound.response,
        rule: built.rule,
        usedFocus: bound.bindings.length > 0,
    };
}

function matchVerb(text: string): { verb: CommandVerb; phrase: string } | null {
    const lower = text.toLowerCase();
    for (const phrase of VERB_PHRASES) {
        if (lower === phrase || lower.startsWith(`${phrase} `)) {
            return { verb: VERB_SYNONYMS[phrase], phrase };
        }
    }
    return null;
}

interface Built {
    slots: { subject: NLSubject; target?: NLTarget };
    rule: FastPathRule;
}

/**
 * The tail of the sentence into subject/target slots, or null.
 *
 * Four shapes, and no fifth: everything the grammar cannot spell exactly goes
 * to the model.
 */
function buildIntent(
    verb: CommandVerb, rest: string, focus: NLFocusSnapshot | null, deps: FastPathDeps,
    whole: string,
): Built | null {
    const subject = () => subjectFor(whole, focus, deps);
    // 1. A bare verb. The focus supplies the target (an elision verb over a
    //    drilled place) or the resolver does (`withdraw`'s departure zone).
    if (!rest) {
        if (verb === 'withdraw') {
            return { slots: { subject: subject() }, rule: 'withdraw-departure' };
        }
        if (!focus?.drilled?.place) return null;
        return { slots: { subject: subject() }, rule: 'verb-elided' };
    }

    // 2. "<verb> <force> to <place>" — both halves exact, and exactly ONE
    //    hinge may split them. Two workable splits means the sentence is
    //    genuinely ambiguous about where the name ends, which is a question,
    //    not a fast path.
    const splits: Array<{ left: string; right: string }> = [];
    for (const hinge of HINGES) {
        const lower = rest.toLowerCase();
        let from = 0;
        for (;;) {
            const at = lower.indexOf(hinge, from);
            if (at < 0) break;
            const left = strip(rest.slice(0, at));
            const right = strip(rest.slice(at + hinge.length));
            if (left && right && exactEntity(left, FORCE_TYPES, deps) && exactEntity(right, PLACE_TYPES, deps)) {
                splits.push({ left, right });
            }
            from = at + 1;
        }
    }
    if (splits.length === 1) {
        return {
            slots: {
                subject: { type: 'entity-ref', name: canonical(splits[0].left, FORCE_TYPES, deps) },
                target: { type: 'entity-ref', name: canonical(splits[0].right, PLACE_TYPES, deps) },
            },
            rule: 'verb-name-to-name',
        };
    }
    if (splits.length > 1) return null;

    // 3. "<verb> <place>" — one exact place name, and nothing else left over.
    const name = strip(rest);
    if (!name) return null;
    if (exactEntity(name, PLACE_TYPES, deps)) {
        return {
            slots: {
                subject: subject(),
                target: { type: 'entity-ref', name: canonical(name, PLACE_TYPES, deps) },
            },
            rule: 'verb-name',
        };
    }

    // 4. "withdraw <force>" — and ONLY withdraw.
    //
    //    A force after a verb is structurally ambiguous: "withdraw Chimera
    //    Squad" can only mean Chimera is who pulls back (a squad is not a
    //    destination), but "defend Chimera Squad" is a sentence about a PLACE
    //    that happens to name a force, and its honest answer is the
    //    place-vs-force refusal — which the resolver words far better than a
    //    grammar can. Reading the force as the subject and quietly eliding a
    //    target out of the open panel would turn that refusal into an order
    //    against somewhere the player never mentioned. So the branch that did
    //    that is gone, and every verb but `withdraw` goes to the model.
    if (verb === 'withdraw' && exactEntity(name, FORCE_TYPES, deps)) {
        return {
            slots: { subject: { type: 'entity-ref', name: canonical(name, FORCE_TYPES, deps) } },
            rule: 'withdraw-departure',
        };
    }

    return null;
}

/**
 * Who acts, when the sentence did not name anyone.
 *
 * The M0 three-way rule, minus its middle branch (a sentence that NAMED a
 * subject never reaches here):
 *
 *  - the player said a subject pronoun ("pull THEM back") ⇒ `selection`,
 *    whatever the board looks like. The word is explicit and the resolver is
 *    where "nothing is selected" becomes a refusal — inferring `any` here would
 *    silently widen an order the player aimed at one squad into a team-wide one.
 *  - something is selected ⇒ `selection`.
 *  - otherwise ⇒ `any`, the compile table's take-whatever-idles subject.
 *
 * The focus is consulted first and the bare `selectionGroupId` only as a
 * fallback: they are the same fact at different resolutions, and the focus is
 * the one the player can see.
 */
function subjectFor(
    whole: string, focus: NLFocusSnapshot | null, deps: FastPathDeps,
): NLSubject {
    if (findSubjectDeictic(whole.toLowerCase()) !== null) return { type: 'selection' };
    if (focus) return focus.selectionCount > 0 ? { type: 'selection' } : { type: 'any' };
    return deps.selectionGroupId != null ? { type: 'selection' } : { type: 'any' };
}

/**
 * The index's own spelling of a name this grammar has already matched EXACTLY.
 *
 * Not a guess and not a widening: `exactEntity` has established that exactly
 * one entity of these types case-folds to this string, so the only thing that
 * can change is capitalisation ("grain silo" → "Grain Silo"). Emitting the
 * canonical form is what makes a fast-path envelope byte-identical to the one
 * the model writes for the same sentence — which is the property the eval
 * scores and the transcript shows the player.
 */
function canonical(name: string, types: EntityType[], deps: FastPathDeps): string {
    const exact = deps.index.searchScored(name, types, 10).filter((h) => h.score >= 1000);
    return exact.length === 1 ? exact[0].entity.name : name;
}

/** Articles and quoting off; whatever survives is matched EXACTLY or not at
 *  all, so this can only ever make a name shorter, never fuzzier. */
function strip(raw: string): string {
    let out = raw.trim().replace(/^["'`]+|["'`,.!?]+$/g, '').trim();
    for (;;) {
        const next = out.replace(/^(?:the|a|an|my|our)\s+/i, '').trim();
        if (next === out) break;
        out = next;
    }
    // Trailing filler a spoken order picks up. Anything else left over is an
    // unclaimed word and the caller will fail the exact-name test on it.
    out = out.replace(/\s+(?:please|now|right\s+now)$/i, '').trim();
    return out;
}

/**
 * Is `name` an EXACT, UNIQUE hit of one of `types` in the index?
 *
 * Exact means the index's own 1000-point tier (`searchScored`) — the tier it
 * awards only to a whole-name case-folded equality. Two entities sharing a name
 * fail this test, and rightly: "West Scarp" when there are two of them is a
 * question, and the resolver already words it.
 *
 * Every other tier — prefix (500) and substring (100) — is REJECTED here even
 * though the resolver would accept a unique one. That is the point of the
 * layer: "Chimera" may well mean Chimera Squad, and a model call is a cheap
 * price for being sure.
 */
function exactEntity(name: string, types: EntityType[], deps: FastPathDeps): boolean {
    const hits = deps.index.searchScored(name, types, 10);
    const exact = hits.filter((h) => h.score >= 1000);
    if (exact.length !== 1) return false;
    // A name that is ALSO an exact hit of the other kind ("Northgate" the
    // region and "Northgate" the squad) is ambiguous across the very
    // distinction this grammar leans on. Stand aside.
    const other = types === PLACE_TYPES ? FORCE_TYPES : PLACE_TYPES;
    return deps.index.searchScored(name, other, 10).filter((h) => h.score >= 1000).length === 0;
}

/** The synonyms, for the eval's coverage report and for the instructions
 *  document's verb glossary to be checked against. */
export const FAST_PATH_VERBS: Readonly<Record<string, CommandVerb>> = VERB_SYNONYMS;
