/**
 * free-text-accelerator.ts — Command composer keyword accelerator
 * (PLAN-metalstorm-scripting.md §3/§12, task 7)
 *
 * OPTIONAL, gated power-user accelerator: a single text field that maps
 * **keywords → slots** ("attack meridian high when contested") using the
 * closed vocabularies as its dictionary. This is a **slot-filler, not an
 * NLP parser** — there is no grammar, no precedence, no free-form logic.
 * Unrecognised words are ignored (returned as `unmatched`, for a transparency
 * hint only); the structured chips remain the source of truth — this module
 * never sends anything, it only proposes slot values the widget applies
 * through the exact same state as a manual chip pick.
 *
 * Deliberately narrower than the full WHEN menu (§2): only the two
 * conditions expressible as a bare keyword are supported here
 * (`under attack`, `contested` — the latter borrows its regionId from the
 * TARGET this same phrase resolves, not from parsing a number/id out of
 * text). `objective-complete` and `strength-below` both need a numeric/id
 * parameter free text can't reliably supply without becoming a parser, so
 * they are intentionally NOT covered — a player who types "if strength
 * below 50%" gets those words ignored and picks the condition from the
 * WHEN chip menu instead (exactly the "unrecognised words are ignored"
 * contract).
 *
 * Positional heuristic: the mental model (§2) is
 * `[SUBJECT] [VERB] [TARGET] · priority · [WHEN]?` — so once the verb
 * keyword is located, an unclaimed run of words BEFORE it is tried against
 * the Subject vocabulary (named group/platoon/army) and a run AFTER it is
 * tried against the Target vocabulary (named entity). This is a fixed
 * positional assumption, not a grammar — a phrase that violates the order
 * simply won't resolve those slots, which is the correct "ignore, don't
 * guess" failure mode for a slot-filler.
 */

import type { CommandVerb, CommandSubject, CommandTarget, WhenCondition } from './compile-table.js';
import type { NamedEntity, EntityType } from './named-entity-index.js';

const VERB_WORDS: CommandVerb[] = [
    'attack', 'secure', 'defend', 'hold', 'patrol',
    'screen', 'scout', 'escort', 'withdraw', 'reinforce', 'build',
];

/** Priority band words (§2 "snaps to labelled bands") — the only priority
 *  vocabulary this accelerator understands; no raw numbers, so a target
 *  named e.g. "Sector 5" can never be misread as a priority value. */
const PRIORITY_WORDS: Record<string, number> = {
    low: 25,
    normal: 50,
    high: 75,
    urgent: 100,
};

/** Closed vocabulary for the idle-filter subject ("idle <class>") — the
 *  11 Metalstorm unit classes (PLAN-metalstorm.md) plus the two aliases
 *  the composer's own subject prompt already uses as examples. */
const IDLE_CLASSES = [
    'engineers', 'soldiers', 'mechs', 'tanks', 'artillery', 'fighters',
    'bombers', 'ships', 'subs', 'statics', 'radar', 'armour', 'infantry',
];

const SUBJECT_ENTITY_TYPES: EntityType[] = ['group', 'platoon', 'army'];
const TARGET_ENTITY_TYPES: EntityType[] = ['region', 'district', 'city', 'objective', 'landmark', 'enemy-force'];
const REGION_LIKE_TYPES: EntityType[] = ['region', 'district', 'city'];

/** Words with no slot meaning — stripped before an unclaimed run is handed
 *  to the named-entity search, so "the" in "the north basin" doesn't dilute
 *  the query or spuriously fuzzy-match an unrelated entity. */
const STOPWORDS = new Set(['the', 'a', 'an', 'at', 'on', 'in', 'to', 'when', 'if', 'priority']);

export interface AcceleratorSearchIndex {
    search(query: string, typeFilter?: EntityType | EntityType[], limit?: number): NamedEntity[];
}

export interface AcceleratorResult {
    verb: CommandVerb | null;
    subject: CommandSubject | null;
    target: CommandTarget | null;
    priority: number | null;
    when: WhenCondition | null;
    /** Words the accelerator never claimed — shown as a transparency hint,
     *  never an error (§3 "unrecognised words are ignored"). */
    unmatched: string[];
}

interface Token {
    word: string;       // lowercased, punctuation-stripped
    original: string;
    consumed: boolean;
}

function tokenize(text: string): Token[] {
    return text
        .split(/\s+/)
        .map((w) => w.trim())
        .filter(Boolean)
        .map((original) => ({
            original,
            word: original.toLowerCase().replace(/[^\w%]/g, ''),
            consumed: false,
        }));
}

/** Join a contiguous, non-stopword slice of tokens back into a search
 *  query. Returns '' if nothing but stopwords remain in the slice. */
function sliceToQuery(tokens: Token[], start: number, end: number): string {
    return tokens
        .slice(start, end)
        .filter((t) => !t.consumed && t.word && !STOPWORDS.has(t.word))
        .map((t) => t.original)
        .join(' ')
        .trim();
}

function markConsumed(tokens: Token[], start: number, end: number): void {
    for (let i = start; i < end; i++) tokens[i].consumed = true;
}

/**
 * Parse free text into slot values (task 7). Pure function — takes the
 * live named-entity index as a parameter so it has no module state and no
 * side effects (matches this file's "proposes, never sends" contract).
 */
export function acceleratorFill(text: string, index: AcceleratorSearchIndex): AcceleratorResult {
    const tokens = tokenize(text);
    const result: AcceleratorResult = {
        verb: null, subject: null, target: null, priority: null, when: null, unmatched: [],
    };

    // ── Verb (single word, closed vocabulary) ──
    let verbIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].consumed && VERB_WORDS.includes(tokens[i].word as CommandVerb)) {
            result.verb = tokens[i].word as CommandVerb;
            tokens[i].consumed = true;
            verbIndex = i;
            break;
        }
    }

    // ── Priority (band words only — see PRIORITY_WORDS doc) ──
    for (const t of tokens) {
        if (!t.consumed && t.word in PRIORITY_WORDS) {
            result.priority = PRIORITY_WORDS[t.word];
            t.consumed = true;
            break;
        }
    }

    // ── When: "under attack" (bigram, no params) ──
    for (let i = 0; i < tokens.length - 1; i++) {
        if (!tokens[i].consumed && !tokens[i + 1].consumed &&
            tokens[i].word === 'under' && tokens[i + 1].word === 'attack') {
            result.when = { type: 'under-attack' };
            markConsumed(tokens, i, i + 2);
            break;
        }
    }

    // "contested" is resolved after the Target search below (it borrows the
    // target's id as regionId) — just claim the word and remember we saw it.
    let contestedRequested = false;
    for (const t of tokens) {
        if (!t.consumed && t.word === 'contested') {
            contestedRequested = true;
            t.consumed = true;
            break;
        }
    }

    // ── Subject: "idle <class>" / "ai" (fixed closed-vocab patterns) ──
    for (let i = 0; i < tokens.length - 1; i++) {
        if (!tokens[i].consumed && !tokens[i + 1].consumed &&
            tokens[i].word === 'idle' && IDLE_CLASSES.includes(tokens[i + 1].word)) {
            result.subject = { type: 'idle-filter', filterClass: tokens[i + 1].word };
            markConsumed(tokens, i, i + 2);
            break;
        }
    }
    if (!result.subject) {
        for (const t of tokens) {
            if (!t.consumed && t.word === 'ai') {
                result.subject = { type: 'ai' };
                t.consumed = true;
                break;
            }
        }
    }

    // Subject: named group/platoon/army, searched in the unclaimed run
    // BEFORE the verb (positional heuristic — see file header).
    if (!result.subject && verbIndex >= 0) {
        const query = sliceToQuery(tokens, 0, verbIndex);
        if (query.length >= 2) {
            const match = index.search(query, SUBJECT_ENTITY_TYPES, 1)[0];
            if (match) {
                result.subject = { type: 'group', groupId: typeof match.id === 'number' ? match.id : Number(match.id) };
                markConsumed(tokens, 0, verbIndex);
            }
        }
    }

    // Target: named entity, searched in the unclaimed run AFTER the verb
    // (or the whole remainder if no verb was recognised).
    const targetStart = verbIndex >= 0 ? verbIndex + 1 : 0;
    const query = sliceToQuery(tokens, targetStart, tokens.length);
    if (query.length >= 2) {
        const match = index.search(query, TARGET_ENTITY_TYPES, 1)[0];
        if (match) {
            result.target = { shape: 'entity', entity: match };
            // Consume only the words the index actually matched, so a
            // trailing word after the entity name (already-consumed
            // when/priority keywords aside) doesn't get silently claimed too.
            const matchWords = new Set(match.name.toLowerCase().split(/\s+/));
            for (let i = targetStart; i < tokens.length; i++) {
                if (!tokens[i].consumed && matchWords.has(tokens[i].word)) tokens[i].consumed = true;
            }
        }
    }

    if (contestedRequested && result.target?.entity && REGION_LIKE_TYPES.includes(result.target.entity.type)) {
        result.when = { type: 'region-contested', regionId: String(result.target.entity.id) };
    }

    result.unmatched = tokens.filter((t) => !t.consumed && t.word && !STOPWORDS.has(t.word)).map((t) => t.original);

    return result;
}
