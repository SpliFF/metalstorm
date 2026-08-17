/**
 * nl-local-patterns.ts — the handful of sentences that work with no LLM at all
 * (PLAN-metalstorm-command-language.md §6 / M3 "hard-coded local patterns")
 *
 *     "zoom to Northgate"                 → camera focus
 *     "show me the minimap, full screen"  → ui fullscreen
 *     "open the diplomacy panel"          → ui open
 *     "how many tanks do we have"         → query count
 *     "where is Chimera Squad" / "locate the enemy tanks" → query locate
 *     "show me the whole map"             → camera fitMap
 *     "follow Hammerfall"                 → camera follow
 *     "move 2 tank squads to Randtown"    → class-count order (M5)
 *
 * These are CLOSED PATTERNS, not NLP. Each is an anchored regular expression
 * over a leading phrase, and everything after the phrase is passed on as a NAME
 * for the resolver to judge — exactly like the rest of the local path
 * (`nl-client.ts`), so a camera or panel reference resolves under the same
 * rules, produces the same clarifications, and refuses with the same voice as an
 * order does. No pattern here resolves anything itself.
 *
 * Why patterns and not the slot-filler: `free-text-accelerator.ts` is a table of
 * things that MOVE ARMIES — its whole shape is `[subject] verb [target]
 * priority [when]`. "How many tanks do we have" has no verb in that table and
 * never will; adding camera and panel verbs to it would make every sentence
 * that mentions a panel name a candidate order. So these live in front of it,
 * the way `parseGroupRename` does, and an unmatched sentence falls through to
 * the accelerator and then to the same transparent refusal as before. Nothing
 * here widens what the local path will accept; it only stops it refusing five
 * sentences it can honestly execute.
 *
 * Word order is load-bearing in one place: "show me the minimap, full screen"
 * must be tried as a FULLSCREEN request before the plain "show me X" panel
 * pattern claims it, or the trailing words would be swallowed and the player
 * would get a rail-sized minimap for a sentence that asked for the opposite.
 */

import type { NLAction, NLPriority, NLQuery, NLScale, NLUiAction } from './nl-envelope.js';
import type { CommandVerb } from './compile-table.js';
import type { ClassVocabulary } from './class-vocabulary.js';

export interface LocalPatternMatch {
    action: NLAction;
    /** The acknowledgement to print if the action succeeds. */
    say: string;
}

export interface LocalPatternDeps {
    /** Shipped class vocabulary — decides whether "how many X" has a class. */
    vocabulary: ClassVocabulary;
    /**
     * Spoken panel name → the registry's panel ID, or null when no panel answers
     * to it (`uiActionRegistry.get(name)?.id`).
     *
     * Two jobs in one hook. It gates: a "show me the X" sentence only becomes a
     * UI action when X is a REGISTERED panel, so "show me Northgate" stays a
     * camera sentence instead of refusing as a missing panel. And it canonicalises
     * to the ID, because the envelope's `panelId` is validated against
     * `registry.ids()` (§1) — emitting the player's phrasing there would produce a
     * well-formed envelope that the validator then rejects.
     */
    resolvePanel(name: string): string | null;
}

// ─────────────────────────── the patterns ───────────────────────────

/** Trailing "full screen" / "fullscreen" / "maximised", with optional comma. */
const FULLSCREEN_TAIL = /[\s,]+(?:in\s+)?(?:full[\s-]?screen|fullscreen|maximi[sz]ed|big)\s*$/i;

/** "show me the X" / "show X" / "open X" / "bring up X" / "pull up X" */
const SHOW_PANEL = /^(?:show(?:\s+me)?|open|bring\s+up|pull\s+up|display)\s+(.+?)\s*$/i;
/** "close X" / "hide X" / "dismiss X" */
const CLOSE_PANEL = /^(?:close|hide|dismiss|shut)\s+(.+?)\s*$/i;
/** "toggle X" */
const TOGGLE_PANEL = /^toggle\s+(.+?)\s*$/i;

/** "zoom to X" / "go to X" / "take me to X" / "look at X" / "focus on X" */
const ZOOM_TO = /^(?:zoom(?:\s+(?:in|out))?\s+(?:to|on)|go\s+to|take\s+me\s+to|look\s+at|focus(?:\s+on)?|centre?\s+on|center\s+on|jump\s+to)\s+(.+?)\s*$/i;
/** "show me the whole map" and friends — before SHOW_PANEL, which would treat
 *  "the whole map" as a panel name and refuse. */
const WHOLE_MAP = /^(?:show(?:\s+me)?|zoom\s+(?:out\s+)?to|fit|view)\s+(?:the\s+)?(?:whole|entire|full)\s+map\s*$/i;
/** "zoom in" / "zoom out", with no target. */
const ZOOM_STEP = /^zoom\s+(in|out)(?:\s+a\s+(?:bit|little))?\s*$/i;
/** "follow X" / "keep the camera on X" / "track X" / "stay on X" */
const FOLLOW = /^(?:follow|track|keep\s+(?:the\s+)?camera\s+on|stay\s+(?:on|with))\s+(.+?)\s*$/i;
/** "stop following" / "let go of the camera" */
const UNFOLLOW = /^(?:stop\s+following|unfollow|release\s+the\s+camera|stop\s+tracking)\s*$/i;

/** "how many X (do we have) (left)" / "how many X are there" */
const HOW_MANY = /^how\s+many\s+(.+?)(?:\s+(?:do|does|have)\s+(?:we|i|they|the\s+enemy)\s*(?:have|got)?)?(?:\s+(?:are\s+there|left|remain(?:ing)?|do\s+we\s+have))?\s*\??\s*$/i;
/** "where is X" / "where's X" / "locate X" / "find X" */
const WHERE_IS = /^(?:where(?:'s|\s+is|\s+are)|locate|find|spot)\s+(.+?)\s*\??\s*$/i;
/** "how is X doing" / "status of X" / "report on X" */
const STATUS = /^(?:status(?:\s+(?:of|on))?|report\s+on|how\s+(?:is|are)\s+(.+?)\s+doing)\s*(.*?)\s*\??\s*$/i;
/** Resource / objective questions — no argument, so a fixed phrase list. */
const RESOURCES = /^(?:how\s+(?:much|many)\s+(?:authority|resources?)|how\s+are\s+we\s+doing\s+on\s+(?:authority|resources?)|authority|what(?:'s|\s+is)\s+(?:my|our)\s+authority)(?:\s+(?:do|have)\s+(?:we|i)(?:\s+(?:have|got))?)?\s*\??\s*$/i;
const OBJECTIVES = /^(?:what(?:'s|\s+is)\s+(?:the\s+)?(?:mission|objectives?)|objectives?|what\s+are\s+we\s+(?:supposed\s+to\s+be\s+)?doing|orders)\s*\??\s*$/i;

/** Side words a count/locate phrase may carry, and which side they mean. The
 *  global twins are for stripping (a non-global `replace` drops one word and
 *  leaves the second, which is how "their enemy tanks" would keep a side word). */
const ENEMY_WORDS = /\b(?:enemy|enemies|hostile|hostiles|their|theirs|them)\b/i;
const ALLY_WORDS = /\b(?:all(?:y|ied|ies)|friendly|friendlies)\b/i;
const ENEMY_WORDS_G = new RegExp(ENEMY_WORDS.source, 'gi');
const ALLY_WORDS_G = new RegExp(ALLY_WORDS.source, 'gi');

/**
 * Try every local pattern, in the order that keeps the ambiguous ones honest.
 * Returns null when nothing matched — the caller then falls through to the
 * slot-filler, and to its refusal if that fails too.
 */
export function matchLocalPattern(
    utterance: string, deps: LocalPatternDeps,
): LocalPatternMatch | null {
    const text = utterance.trim().replace(/\s+/g, ' ');
    if (!text) return null;

    return (
        matchClassCountOrder(text, deps)   // before everything: "send two tank
                                           // squads to X" starts like nothing
                                           // else here, and the slot-filler has
                                           // no subject slot that can hold it
        ?? matchWholeMap(text)
        ?? matchZoomStep(text)
        ?? matchUnfollow(text)
        ?? matchPanel(text, deps)          // before the camera patterns: "show me
                                           // the minimap" is a panel, not a place
        ?? matchFollow(text)
        ?? matchZoomTo(text)
        ?? matchHowMany(text, deps)
        ?? matchWhereIs(text)
        ?? matchResources(text)
        ?? matchObjectives(text)
        ?? matchStatus(text)
        ?? null
    );
}

// ────────────────────── a counted class of squads ──────────────────────

/**
 * "move 2 tank squads to Randtown" — the plan's own example utterance, and the
 * one shape of order the slot-filler structurally cannot carry.
 *
 * `free-text-accelerator.ts` fills a `CommandSubject`, whose cases are group /
 * idle-filter / ai / selection: there is nowhere in it to put "two of the tank
 * squads, you pick which". The envelope has had `class-count` since M1 and the
 * resolver has ranked and fanned it out since M1 — only the offline PRODUCER was
 * missing, so the sentence worked through the proxy and refused without it.
 *
 * That gap mattered more than it looks: `class-count` is the subject that raises
 * the M5 "which two?" question, so the whole clarification flow was reachable
 * only with an API key. It is a closed pattern like the rest of this file — a
 * count, a class phrase the shipped vocabulary recognises, a place name handed
 * on unresolved.
 */
const CLASS_COUNT_ORDER = new RegExp(
    '^(?:(move|send|get|push|take|order|attack|assault|hit|defend|hold|garrison|guard|screen|scout)\\s+)?'
    + '(\\d{1,2}|one|two|three|four)\\s+'          // the count
    + '(?:of\\s+(?:my|our|the)\\s+)?'
    + '(.+?)\\s+'                                  // the class phrase
    + '(?:squads?|groups?|platoons?|flights?|units?)\\s+'
    + '(?:to|into|onto|towards?|at|on|over\\s+to)\\s+'
    + '(.+?)'                                      // the place
    + '(?:\\s+(low|normal|high|urgent)(?:\\s+priority)?)?\\s*$',
    'i',
);

const WORD_COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

/**
 * Which verb a leading word means. Deliberately the same readings the M0
 * slot-filler uses, so "defend Northgate" and "defend 2 tank squads to
 * Northgate" cannot come to mean different things — and `move`/`send` map to
 * `secure`, which is what the accelerator has always compiled a move-to-a-place
 * order into.
 */
const CLASS_COUNT_VERBS: Record<string, CommandVerb> = {
    move: 'secure', send: 'secure', get: 'secure', push: 'secure',
    take: 'secure', order: 'secure',
    attack: 'attack', assault: 'attack', hit: 'attack',
    defend: 'defend', guard: 'defend', garrison: 'defend',
    hold: 'hold', screen: 'screen', scout: 'scout',
};

function matchClassCountOrder(text: string, deps: LocalPatternDeps): LocalPatternMatch | null {
    const m = CLASS_COUNT_ORDER.exec(text);
    if (!m) return null;

    const [, verbWord, countWord, classPhrase, placePhrase, priorityWord] = m;

    const count = WORD_COUNTS[countWord.toLowerCase()] ?? Number(countWord);
    if (!Number.isInteger(count) || count < 1 || count > 16) return null;

    // The class phrase must be one the SHIPPED vocabulary knows. Anything else
    // falls through to the accelerator and its refusal — "send 2 doom squads to
    // Randtown" is not an order this pattern gets to invent a class for.
    const phrase = stripSideWords(cleanRef(classPhrase));
    if (!phrase || !deps.vocabulary.lookup(phrase)) return null;

    const place = cleanRef(placePhrase);
    if (!place) return null;

    const verb = CLASS_COUNT_VERBS[(verbWord ?? 'move').toLowerCase()] ?? 'secure';
    const priority = priorityWord?.toLowerCase() as NLPriority | undefined;

    return {
        action: {
            kind: 'command',
            intent: {
                verb,
                subject: { type: 'class-count', class: phrase, count },
                target: { type: 'entity-ref', name: place },
                ...(priority ? { priority } : {}),
            },
        },
        // The order, not its outcome — resolution can still ask which squads.
        say: `${verb} ${place} with ${count} ${phrase} ${count === 1 ? 'squad' : 'squads'}`,
    };
}

// ─────────────────────────── camera ───────────────────────────

function matchWholeMap(text: string): LocalPatternMatch | null {
    if (!WHOLE_MAP.test(text)) return null;
    return { action: { kind: 'camera', camera: { op: 'fitMap' } }, say: 'showing the whole map' };
}

function matchZoomStep(text: string): LocalPatternMatch | null {
    const m = ZOOM_STEP.exec(text);
    if (!m) return null;
    const dir = m[1].toLowerCase() as 'in' | 'out';
    return { action: { kind: 'camera', camera: { op: 'zoom', dir } }, say: `zooming ${dir}` };
}

function matchZoomTo(text: string): LocalPatternMatch | null {
    const m = ZOOM_TO.exec(text);
    if (!m) return null;
    const name = cleanRef(m[1]);
    if (!name) return null;
    return {
        action: { kind: 'camera', camera: { op: 'focus', targetRef: name } },
        say: `camera to ${name}`,
    };
}

function matchFollow(text: string): LocalPatternMatch | null {
    const m = FOLLOW.exec(text);
    if (!m) return null;
    const name = cleanRef(m[1]);
    if (!name) return null;
    return {
        action: { kind: 'camera', camera: { op: 'follow', targetRef: name } },
        say: `following ${name}`,
    };
}

/**
 * "stop following" has no envelope action of its own — there is no
 * `camera.stopFollow` op, and inventing one would put a shape in the schema the
 * LLM could emit for a follow that isn't running. A zoom step of zero would be a
 * lie about what happened, so this maps to `fitMap`: the camera visibly returns
 * to the player's control, which is what was asked, and the port cancels the
 * follow because ANY camera action cancels it.
 */
function matchUnfollow(text: string): LocalPatternMatch | null {
    if (!UNFOLLOW.test(text)) return null;
    return {
        action: { kind: 'camera', camera: { op: 'fitMap' } },
        say: 'camera released — showing the whole map',
    };
}

// ─────────────────────────── panels ───────────────────────────

function matchPanel(text: string, deps: LocalPatternDeps): LocalPatternMatch | null {
    // Fullscreen FIRST — see the file header on word order.
    const fullscreen = FULLSCREEN_TAIL.exec(text);
    if (fullscreen) {
        const head = text.slice(0, fullscreen.index);
        const shown = SHOW_PANEL.exec(head) ?? TOGGLE_PANEL.exec(head);
        const name = shown ? cleanRef(shown[1]) : cleanRef(head);
        const panel = name ? deps.resolvePanel(name) : null;
        if (panel) return uiMatch('fullscreen', panel, `${name} full screen`);
        return null;
    }

    for (const [pattern, op] of [
        [SHOW_PANEL, 'open'], [CLOSE_PANEL, 'close'], [TOGGLE_PANEL, 'toggle'],
    ] as Array<[RegExp, NLUiAction['op']]>) {
        const m = pattern.exec(text);
        if (!m) continue;
        const name = cleanRef(m[1]);
        const panel = name ? deps.resolvePanel(name) : null;
        if (panel) return uiMatch(op, panel, `${op === 'close' ? 'closing' : 'opening'} ${name}`);
    }
    return null;
}

function uiMatch(op: NLUiAction['op'], panelId: string, say: string): LocalPatternMatch {
    return { action: { kind: 'ui', ui: { op, panelId } }, say };
}

// ─────────────────────────── queries ───────────────────────────

function matchHowMany(text: string, deps: LocalPatternDeps): LocalPatternMatch | null {
    const m = HOW_MANY.exec(text);
    if (!m) return null;
    const phrase = cleanRef(m[1]);
    if (!phrase) return null;

    const side = sideOf(text);
    const bare = stripSideWords(phrase);
    const match = deps.vocabulary.lookup(bare);
    if (!match) return null;                   // not a class — let the fall-through refuse

    // The vocabulary already pinned a scale if the phrase named one ("heavy
    // tanks" → 3); passing it explicitly as well is redundant but harmless, and
    // it keeps the envelope self-describing for the transcript and the eval set.
    const scale = match.kind === 'class' && match.scale != null
        ? (match.scale as NLScale) : undefined;

    const query: NLQuery = { op: 'count', class: bare, side, ...(scale ? { scale } : {}) };
    return { action: { kind: 'query', query }, say: `counting ${phrase}` };
}

function matchWhereIs(text: string): LocalPatternMatch | null {
    const m = WHERE_IS.exec(text);
    if (!m) return null;
    const name = cleanRef(m[1]);
    if (!name) return null;
    const side = sideOf(text) === 'enemy' ? 'enemy' : 'own';
    return {
        action: { kind: 'query', query: { op: 'locate', targetRef: name, side } },
        say: `looking for ${name}`,
    };
}

function matchResources(text: string): LocalPatternMatch | null {
    if (!RESOURCES.test(text)) return null;
    return { action: { kind: 'query', query: { op: 'resources' } }, say: 'checking authority' };
}

function matchObjectives(text: string): LocalPatternMatch | null {
    if (!OBJECTIVES.test(text)) return null;
    return { action: { kind: 'query', query: { op: 'objectives' } }, say: 'checking objectives' };
}

function matchStatus(text: string): LocalPatternMatch | null {
    const m = STATUS.exec(text);
    if (!m) return null;
    const name = cleanRef(m[1] || m[2]);
    if (!name) return null;
    return {
        action: { kind: 'query', query: { op: 'status', subjectRef: name } },
        say: `checking ${name}`,
    };
}

// ─────────────────────────── helpers ───────────────────────────

/** Trim the articles, filler and punctuation a spoken reference arrives with.
 *  Whatever survives still faces the envelope validator's charset gate. */
function cleanRef(raw: string): string {
    return (raw ?? '')
        .trim()
        .replace(/^(?:the|a|an|my|our)\s+/i, '')
        .replace(/\s+(?:please|now|for\s+me)$/i, '')
        .replace(/^["'`]+|["'`.!?,]+$/g, '')
        .trim();
}

function sideOf(text: string): 'own' | 'enemy' | 'ally' {
    if (ENEMY_WORDS.test(text)) return 'enemy';
    if (ALLY_WORDS.test(text)) return 'ally';
    return 'own';
}

/** Side words are carried by the query's `side`, not by its class phrase — the
 *  vocabulary knows "tanks", not "enemy tanks". */
function stripSideWords(phrase: string): string {
    return phrase
        .replace(ENEMY_WORDS_G, ' ')
        .replace(ALLY_WORDS_G, ' ')
        .replace(/\b(?:our|my|the|of|units?)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
