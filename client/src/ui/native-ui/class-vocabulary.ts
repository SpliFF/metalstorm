/**
 * class-vocabulary.ts — loader for the shipped unit-class vocabulary
 * (PLAN-metalstorm-command-language.md §2, M0)
 *
 * The anti-drift fix. What a player SAYS ("heavy tanks", "statics", "air
 * defense") maps to what the sim CALLS things (`customparams.ms_class` +
 * `ms_scale`, set in `data/games/metalstorm/units/_builder.lua`) through ONE
 * shipped data file — `<game>/ui/class-vocabulary.json`, fetched alongside
 * `<game>.ui.json` by the widget loader. Before this, the mapping lived in a
 * hand-kept array inside `free-text-accelerator.ts` that had already drifted
 * from the taxonomy (`statics` for a class actually called `staticdefense`,
 * invented `armour`/`infantry` classes, no `buildings`/`civilians`/
 * `civvehicles`).
 *
 * Design pillar 5, "one vocabulary, many consumers": the local slot-filler
 * (free-text-accelerator), the command console, and — from M1 — the LLM system
 * prompt, typed autocomplete and the command builder all read this one table,
 * so they cannot disagree about what a "heavy tank" is.
 *
 * This module is data + lookup only. It resolves a PHRASE to a class/role; it
 * never decides what to do with one.
 */

/** One class entry, keyed in the JSON by its literal `ms_class` value. */
export interface ClassVocabularyEntry {
    /** Singular UI text ("Tank"). */
    display: string;
    /** How the class is normally spoken in the plural ("tanks"). */
    plural?: string;
    /** Alternative spellings — never new classes. */
    synonyms?: string[];
    /** `ms_scale` ("1".."4") → phrases that pin that scale ("heavy tanks"). */
    scales?: Record<string, string[]>;
}

/** One clause of a role definition. Fields AND together. */
export interface RoleMatch {
    class: string;
    scale?: number;
    scaleMin?: number;
    scaleMax?: number;
}

/** A spoken grouping that spans classes ("air defense") or slices one by scale. */
export interface RoleVocabularyEntry {
    display?: string;
    synonyms?: string[];
    /** OR-ed: a unit matching ANY clause is in the role. */
    matches: RoleMatch[];
}

export interface ClassVocabularyData {
    version?: number;
    classes: Record<string, ClassVocabularyEntry>;
    roles?: Record<string, RoleVocabularyEntry>;
}

/** What a matched phrase resolved to, before the word count is attached. */
export type VocabularyMatchBody =
    | {
          kind: 'class';
          /** The literal `ms_class` value. */
          className: string;
          /** `ms_scale` the phrase pinned, if it named one ("heavy tanks" → 3). */
          scale: number | null;
          /** Display text for an echo line ("heavy tanks"). */
          label: string;
      }
    | {
          kind: 'role';
          roleName: string;
          matches: RoleMatch[];
          label: string;
      };

/** A resolved phrase. `words` is how many whitespace-separated words it
 *  consumed — the caller needs it to know how far to advance. */
export type VocabularyMatch = VocabularyMatchBody & { words: number };

interface PhraseEntry {
    phrase: string;
    words: number;
    match: VocabularyMatchBody;
}

/**
 * Normalise a phrase to the exact shape `free-text-accelerator.ts`'s tokenizer
 * produces: lowercase, non-word characters dropped (`%` kept), runs of space
 * collapsed. It MUST match that tokenizer — a phrase normalised any other way
 * silently never matches a typed word. That is why hyphens go: the tokenizer
 * turns "super-heavy" into "superheavy", so the vocabulary must too (authors
 * may spell it either way in the JSON; both normalise to one phrase).
 */
function normalisePhrase(text: string): string {
    return text
        .toLowerCase()
        .split(/\s+/)
        .map((w) => w.replace(/[^\w%]/g, ''))
        .filter(Boolean)
        .join(' ');
}

/**
 * An immutable, loaded vocabulary. Construct with `ClassVocabulary.fromData`
 * (validating) or take the shared `classVocabulary` holder the widget loader
 * populates.
 */
export class ClassVocabulary {
    /** Longest phrase first, so "heavy tanks" wins over "tanks". */
    private readonly phrases: PhraseEntry[];
    readonly data: ClassVocabularyData;
    /** Word count of the longest phrase — bounds the caller's lookahead. */
    readonly maxPhraseWords: number;

    private constructor(data: ClassVocabularyData, phrases: PhraseEntry[]) {
        this.data = data;
        this.phrases = phrases;
        this.maxPhraseWords = phrases.reduce((m, p) => Math.max(m, p.words), 0);
    }

    static empty(): ClassVocabulary {
        return new ClassVocabulary({ classes: {} }, []);
    }

    /**
     * Build from parsed JSON. Malformed entries are skipped with a warning
     * rather than throwing — a bad vocabulary must cost the player keyword
     * coverage, never their HUD.
     */
    static fromData(data: ClassVocabularyData): ClassVocabulary {
        const phrases: PhraseEntry[] = [];
        const claimed = new Map<string, string>();

        const claim = (phrase: string, owner: string, match: VocabularyMatchBody) => {
            const norm = normalisePhrase(phrase);
            if (!norm) return;
            const prior = claimed.get(norm);
            if (prior) {
                // Two entries claiming one phrase is exactly the drift this
                // file exists to prevent; first claim wins, loudly.
                if (prior !== owner) {
                    console.warn(`[class-vocabulary] phrase "${norm}" claimed by both ${prior} and ${owner} — keeping ${prior}`);
                }
                return;
            }
            claimed.set(norm, owner);
            phrases.push({ phrase: norm, words: norm.split(' ').length, match });
        };

        for (const [className, entry] of Object.entries(data.classes ?? {})) {
            if (!entry || typeof entry.display !== 'string') {
                console.warn(`[class-vocabulary] class "${className}" has no display text — skipped`);
                continue;
            }
            const label = entry.plural || entry.display;
            const owner = `class:${className}`;
            const base = { kind: 'class' as const, className, scale: null, label };
            // The ms_class key itself is always speakable — a player (or a
            // fixture) may use the sim's own word.
            claim(className, owner, base);
            claim(entry.display, owner, base);
            if (entry.plural) claim(entry.plural, owner, base);
            for (const syn of entry.synonyms ?? []) claim(syn, owner, base);

            for (const [scaleKey, scalePhrases] of Object.entries(entry.scales ?? {})) {
                const scale = Number(scaleKey);
                if (!Number.isInteger(scale) || scale < 1 || scale > 4) {
                    console.warn(`[class-vocabulary] class "${className}" has invalid scale key "${scaleKey}" — skipped`);
                    continue;
                }
                for (const phrase of scalePhrases ?? []) {
                    claim(phrase, `${owner}:s${scale}`, {
                        kind: 'class', className, scale, label: normalisePhrase(phrase),
                    });
                }
            }
        }

        for (const [roleName, entry] of Object.entries(data.roles ?? {})) {
            if (!entry || !Array.isArray(entry.matches) || entry.matches.length === 0) {
                console.warn(`[class-vocabulary] role "${roleName}" has no matches — skipped`);
                continue;
            }
            const owner = `role:${roleName}`;
            const base = {
                kind: 'role' as const,
                roleName,
                matches: entry.matches,
                label: entry.display || roleName,
            };
            claim(roleName, owner, base);
            if (entry.display) claim(entry.display, owner, base);
            for (const syn of entry.synonyms ?? []) claim(syn, owner, base);
        }

        phrases.sort((a, b) => b.words - a.words || a.phrase.localeCompare(b.phrase));
        return new ClassVocabulary(data, phrases);
    }

    /** Every `ms_class` this vocabulary knows. */
    classNames(): string[] {
        return Object.keys(this.data.classes ?? {});
    }

    /** Every role name this vocabulary knows. */
    roleNames(): string[] {
        return Object.keys(this.data.roles ?? {});
    }

    hasClass(className: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.data.classes ?? {}, className);
    }

    /** Resolve one exact phrase ("heavy tanks"), or null. */
    lookup(phrase: string): VocabularyMatch | null {
        const norm = normalisePhrase(phrase);
        if (!norm) return null;
        const hit = this.phrases.find((p) => p.phrase === norm);
        return hit ? { ...hit.match, words: hit.words } : null;
    }

    /**
     * Longest-phrase match anchored at `words[start]` — the form a slot-filler
     * needs. Returns null when nothing matches, so the caller leaves the words
     * unclaimed instead of guessing (free-text-accelerator's contract).
     */
    matchAt(words: string[], start: number): VocabularyMatch | null {
        const limit = Math.min(this.maxPhraseWords, words.length - start);
        for (let n = limit; n >= 1; n--) {
            const hit = this.lookup(words.slice(start, start + n).join(' '));
            if (hit) return hit;
        }
        return null;
    }

    /** Human-readable list for a "known words" hint in the console. */
    describeClasses(): string {
        return this.classNames()
            .map((c) => this.data.classes[c].plural || this.data.classes[c].display)
            .join(', ');
    }
}

/**
 * Shared holder, populated by the widget loader from the game dir the same way
 * the widget manifest is. Widgets read `classVocabulary.current` rather than
 * fetching for themselves — a widget must not know the game's HTTP base.
 *
 * Before load (and after a failed load) `current` is an EMPTY vocabulary, not a
 * hardcoded fallback list: a keyword the vocabulary doesn't cover is reported
 * as unrecognised, which is the honest failure mode. A silent built-in copy is
 * how the old IDLE_CLASSES drifted in the first place.
 */
class ClassVocabularyHolder {
    current: ClassVocabulary = ClassVocabulary.empty();
    /** True once a real vocabulary has been loaded for the current game. */
    loaded = false;

    set(vocabulary: ClassVocabulary): void {
        this.current = vocabulary;
        this.loaded = true;
    }

    reset(): void {
        this.current = ClassVocabulary.empty();
        this.loaded = false;
    }
}

export const classVocabulary = new ClassVocabularyHolder();

/**
 * Fetch `<gameId>/ui/class-vocabulary.json` and populate the shared holder.
 *
 * Same convention, same cache-stamping and same never-fatal failure handling as
 * `widget-loader.ts`'s manifest/stylesheet fetches — a game that ships no
 * vocabulary simply gets no keyword class coverage.
 */
export async function loadClassVocabulary(
    gameId: string,
    httpBase: string,
): Promise<ClassVocabulary | null> {
    try {
        // Imported lazily: `config.ts` reads `globalThis.location` at module
        // scope, which doesn't exist under the node test environment. Keeping
        // it out of this module's static graph is what lets the vocabulary and
        // the parsers that read it be unit-tested without a browser.
        const { stampUrl } = await import('../../config.js');
        const url = stampUrl(
            `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui/class-vocabulary.json`,
        );
        const res = await fetch(url);
        if (!res.ok) {
            console.log(`[class-vocabulary] No vocabulary for ${gameId} (${res.status})`);
            return null;
        }
        const data = await res.json() as ClassVocabularyData;
        const vocabulary = ClassVocabulary.fromData(data);
        classVocabulary.set(vocabulary);
        console.log(
            `[class-vocabulary] Loaded ${vocabulary.classNames().length} classes, ` +
            `${vocabulary.roleNames().length} roles for ${gameId}`,
        );
        return vocabulary;
    } catch (e) {
        console.error('[class-vocabulary] Failed to load vocabulary:', e);
        return null;
    }
}
