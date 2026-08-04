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
 * Its dictionary is not written here. Verbs/priorities/conditions come from
 * `compile-table.ts`'s closed vocabularies; unit classes come from the SHIPPED
 * `class-vocabulary.json` handed in as a parameter (`class-vocabulary.ts`) —
 * one table, matched longest-phrase-first, canonicalised to the sim's own
 * `customparams.ms_class`. The hand-kept `IDLE_CLASSES` array this file used
 * to carry had already drifted from the taxonomy (`statics` for a class really
 * called `staticdefense`, invented `armour`/`infantry` classes, no
 * `buildings`/`civilians`/`civvehicles`), which is exactly the failure the
 * data file plus its consistency test now prevent.
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
import type { ClassVocabulary, VocabularyMatch } from './class-vocabulary.js';

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
    /**
     * `ms_scale` the idle-filter phrase named ("idle heavy tanks" → 3), or
     * null. PARSE-ONLY: `CommandSubject` has no scale slot, so nothing
     * downstream of here consumes it yet — it is surfaced so the console can
     * echo what it heard instead of quietly widening "heavy tanks" to "tanks",
     * and so the M1 envelope (which does carry scale) has it ready.
     */
    subjectScale: number | null;
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

function markConsumed(tokens: Token[], start: number, end: number): void {
    for (let i = start; i < end; i++) tokens[i].consumed = true;
}

/**
 * Find the named entity a run of words refers to, and consume the words that
 * named it.
 *
 * The run is first tried whole; if the index has no match for it, progressively
 * shorter contiguous spans are tried, longest first. That is what lets
 * "defend Northgate quickly" resolve Northgate and report "quickly" as
 * unmatched, instead of failing the whole slot because one filler word rode
 * along — the index matches by substring (`named-entity-index.ts`), so a query
 * with any extra word in it matches nothing at all.
 *
 * Longest-span-first keeps it specific rather than greedy: "North Basin" is
 * tried before "North" alone, so a longer name always wins over a shorter one
 * it contains. Stopwords are skipped when building spans ("the north basin" ⇒
 * "north basin") but stay in the sentence, so they are never reported as
 * unrecognised.
 *
 * Only the words that appear in the matched entity's own name are consumed —
 * everything else stays unclaimed and ends up in `unmatched`, which is the
 * transparency contract this module is built on.
 */
function claimEntityInRun(
    tokens: Token[],
    from: number,
    to: number,
    types: EntityType[],
    index: AcceleratorSearchIndex,
): NamedEntity | null {
    const candidates: number[] = [];
    for (let i = from; i < to; i++) {
        if (!tokens[i].consumed && tokens[i].word && !STOPWORDS.has(tokens[i].word)) candidates.push(i);
    }

    for (let span = candidates.length; span >= 1; span--) {
        for (let start = 0; start + span <= candidates.length; start++) {
            const window = candidates.slice(start, start + span);
            const query = window.map((i) => tokens[i].original).join(' ').trim();
            if (query.length < 2) continue;

            const match = index.search(query, types, 1)[0];
            if (!match) continue;

            const matchWords = new Set(match.name.toLowerCase().split(/\s+/).map((w) => w.replace(/[^\w%]/g, '')));
            for (const i of window) {
                if (matchWords.has(tokens[i].word)) tokens[i].consumed = true;
            }
            return match;
        }
    }
    return null;
}

/**
 * Reduce a vocabulary match to the single `ms_class` (+ optional scale) that
 * `CommandSubject.filterClass` can carry, or null when it can't be reduced.
 *
 * A role spanning two classes ("air defense" = staticdefense s2+ ∪ fighters)
 * has no single-class form, and picking one branch would be exactly the guess
 * this module refuses to make — so it stays unresolved, its words stay
 * unclaimed, and they surface in `unmatched`. The M1 envelope carries roles
 * properly (`NLCommandIntent.subject`, plan §1).
 */
function toSingleClass(match: VocabularyMatch): { className: string; scale: number | null } | null {
    if (match.kind === 'class') return { className: match.className, scale: match.scale };

    const classes = new Set(match.matches.map((m) => m.class));
    if (classes.size !== 1) return null;
    const only = match.matches[0];
    // One clause with an exact `scale` keeps that scale. A bounded range
    // (scaleMin/scaleMax) has no single-scale form, so no scale is reported —
    // the whole class is what the order will actually act on, and that is what
    // the caller echoes.
    const scale = match.matches.length === 1 && typeof only.scale === 'number' ? only.scale : null;
    return { className: only.class, scale };
}

/**
 * Parse free text into slot values (task 7). Pure function — takes the live
 * named-entity index AND the loaded class vocabulary as parameters so it has
 * no module state and no side effects (matches this file's "proposes, never
 * sends" contract).
 *
 * `vocabulary` is the shipped `class-vocabulary.json`
 * (`class-vocabulary.ts`), not a list kept here: an empty vocabulary simply
 * means no `idle <class>` phrase resolves and those words are reported
 * unmatched. There is deliberately no built-in fallback list — the built-in
 * list is what drifted.
 */
export function acceleratorFill(
    text: string,
    index: AcceleratorSearchIndex,
    vocabulary: ClassVocabulary,
): AcceleratorResult {
    const tokens = tokenize(text);
    const result: AcceleratorResult = {
        verb: null, subject: null, target: null, priority: null, when: null,
        unmatched: [], subjectScale: null,
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
    // The class half is the SHIPPED vocabulary, matched longest-phrase-first
    // so "idle heavy tanks" beats "idle … tanks", and canonicalised to the
    // real `ms_class` — "idle statics" fills `staticdefense`, the name the
    // sim actually uses.
    const words = tokens.map((t) => t.word);
    for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i].consumed || tokens[i].word !== 'idle') continue;
        const hit = vocabulary.matchAt(words, i + 1);
        if (!hit) continue;
        // Nothing in the run may already be claimed (a priority/when keyword
        // sitting inside it means this isn't the class phrase we think it is).
        if (tokens.slice(i + 1, i + 1 + hit.words).some((t) => t.consumed)) continue;
        const single = toSingleClass(hit);
        if (!single) continue;   // multi-class role — leave the words unclaimed
        result.subject = { type: 'idle-filter', filterClass: single.className };
        result.subjectScale = single.scale;
        markConsumed(tokens, i, i + 1 + hit.words);
        break;
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
        const match = claimEntityInRun(tokens, 0, verbIndex, SUBJECT_ENTITY_TYPES, index);
        if (match) {
            result.subject = { type: 'group', groupId: typeof match.id === 'number' ? match.id : Number(match.id) };
        }
    }

    // Target: named entity, searched in the unclaimed run AFTER the verb
    // (or the whole remainder if no verb was recognised).
    const targetStart = verbIndex >= 0 ? verbIndex + 1 : 0;
    const match = claimEntityInRun(tokens, targetStart, tokens.length, TARGET_ENTITY_TYPES, index);
    if (match) {
        result.target = { shape: 'entity', entity: match };
    }

    if (contestedRequested && result.target?.entity
        && REGION_LIKE_TYPES.includes(result.target.entity.type)) {
        result.when = { type: 'region-contested', regionId: String(result.target.entity.id) };
    }

    result.unmatched = tokens.filter((t) => !t.consumed && t.word && !STOPWORDS.has(t.word)).map((t) => t.original);

    return result;
}
