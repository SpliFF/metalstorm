/**
 * ui-action-registry.ts — the panels a sentence can name
 * (PLAN-metalstorm-command-language.md §6.3, milestone M3)
 *
 * "Show me the minimap, full screen" · "open the diplomacy panel" · "close the
 * scoreboard".
 *
 * The HUD has two populations of panel and neither could be addressed by name
 * before this file. Manifest widgets (`metalstorm.ui.json`) are wrapped in
 * loader-owned chrome that already knows how to collapse them, so they
 * self-register from `widget-loader.ts` and their `nlAliases` come from the
 * manifest — one place, next to the title the player reads. Engine HUD elements
 * (the minimap, and whatever follows it) have no manifest at all and register
 * themselves from wherever they are built.
 *
 * Two rules:
 *
 *  1. **A registry entry is a capability claim.** `fullscreen` is optional
 *     because most panels have no such mode; asking for it where it doesn't
 *     exist REFUSES by name rather than falling back to `open` — a player who
 *     said "full screen" and got a 236px rail panel has been misled, and the
 *     lie is the kind that makes a voice interface feel broken.
 *  2. **Aliases are matched, never guessed.** Lookup is exact-then-alias over a
 *     closed set (normalised for case, punctuation and the leading article a
 *     player says out loud). There is no fuzzy fallback: "show me the pineapple
 *     panel" refuses, because opening the nearest-sounding panel to a word the
 *     player didn't say is worse than admitting the miss.
 */

import type { Resolution } from './nl-resolver.js';

/** What a registered panel can be asked to do. */
export interface UiActionEntry {
    /** Stable id — the manifest widget id, or a chosen id for engine HUD. */
    id: string;
    /** Human label for transcript copy ("Diplomacy panel"). */
    label: string;
    /** Extra phrasings a player might use. Normalised on registration. */
    aliases?: readonly string[];
    open(): void;
    close(): void;
    toggle(): void;
    /** Present ⇒ this panel HAS a full-screen mode. Return value reports
     *  whether the mode is now on, so the console can echo the truth. */
    fullscreen?(on?: boolean): boolean;
    /** True while the panel is open. Used to make `toggle` echo honestly. */
    isOpen?(): boolean;
}

export type UiActionOp = 'open' | 'close' | 'toggle' | 'fullscreen';

export type UiActionResult =
    | { ok: true; text: string }
    | { ok: false; reason: string };

/**
 * Normalise a spoken panel name.
 *
 * Everything a player might vary and never mean anything by: case, the leading
 * article, punctuation, the trailing noun "panel"/"window" (so "diplomacy",
 * "diplomacy panel" and "the Diplomacy Panel" are one key), and internal
 * separators (so `parley-panel` and "parley panel" match).
 */
export function normalisePanelName(raw: string): string {
    return raw
        .toLowerCase()
        .replace(/[_\-]+/g, ' ')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:the|a|an|my)\s+/, '')
        .replace(/\s+(?:panel|window|display|view)$/, '')
        .trim();
}

export class UiActionRegistry {
    private entries = new Map<string, UiActionEntry>();
    /** normalised name → entry id. Includes the id itself and every alias. */
    private byName = new Map<string, string>();

    /**
     * Register (or re-register) a panel. Returns an unregister function, which
     * is what a widget's `dispose()` calls — a registry that outlived its panels
     * would answer "opened" for a panel that is no longer in the DOM.
     */
    register(entry: UiActionEntry): () => void {
        this.entries.set(entry.id, entry);
        for (const name of this.namesFor(entry)) {
            const existing = this.byName.get(name);
            if (existing && existing !== entry.id) {
                // Two panels claiming one phrase means every sentence using it
                // is a coin flip. Loud, and first-registration wins so the
                // behaviour is at least deterministic.
                //
                // Audited M5 (§7 "no silent drops"): a `console.warn` and NOT a
                // transcript line, deliberately. This fires at widget-load time,
                // before any player has said anything — there is no exchange to
                // attach it to, and the audience is whoever wrote the manifest,
                // not whoever is playing. The player-visible half is that the
                // phrase still resolves, to the first claimant, every time.
                console.warn(
                    `[ui-action-registry] "${name}" is claimed by both ${existing} and ${entry.id}; ` +
                    `keeping ${existing}`);
                continue;
            }
            this.byName.set(name, entry.id);
        }
        return () => this.unregister(entry.id);
    }

    unregister(id: string): void {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        for (const [name, owner] of [...this.byName.entries()]) {
            if (owner === id) this.byName.delete(name);
        }
    }

    /** Every registered id — the envelope validator's `panelIds` (§1). */
    ids(): string[] {
        return [...this.entries.keys()];
    }

    /** Every phrase that resolves, for the help line and the LLM context (§2). */
    names(): string[] {
        return [...this.byName.keys()].sort();
    }

    get(idOrName: string): UiActionEntry | undefined {
        const direct = this.entries.get(idOrName);
        if (direct) return direct;
        const id = this.byName.get(normalisePanelName(idOrName));
        return id ? this.entries.get(id) : undefined;
    }

    /** Apply an op by name. The only entry point the executor uses. */
    apply(op: UiActionOp, panelName: string): UiActionResult {
        const entry = this.get(panelName);
        if (!entry) {
            return { ok: false, reason: `I don't have a panel called "${panelName}".` };
        }

        switch (op) {
            case 'open':
                entry.open();
                return { ok: true, text: `${entry.label} open` };

            case 'close':
                entry.close();
                return { ok: true, text: `${entry.label} closed` };

            case 'toggle': {
                entry.toggle();
                // Report the state AFTER the toggle when the panel can tell us;
                // "toggled" alone leaves the player guessing which way it went.
                const open = entry.isOpen?.();
                if (open === undefined) return { ok: true, text: `${entry.label} toggled` };
                return { ok: true, text: `${entry.label} ${open ? 'open' : 'closed'}` };
            }

            case 'fullscreen': {
                if (!entry.fullscreen) {
                    return {
                        ok: false,
                        reason: `${entry.label} has no full-screen mode — I can only open or close it.`,
                    };
                }
                const on = entry.fullscreen();
                return { ok: true, text: `${entry.label} ${on ? 'full screen' : 'back to normal size'}` };
            }
        }
    }

    clear(): void {
        this.entries.clear();
        this.byName.clear();
    }

    /** id + aliases + the label, all normalised. The label is included because
     *  "Scoreboard" is what the player sees and therefore what they say. */
    private namesFor(entry: UiActionEntry): string[] {
        const names = new Set<string>();
        for (const raw of [entry.id, entry.label, ...(entry.aliases ?? [])]) {
            const name = normalisePanelName(raw);
            if (name) names.add(name);
        }
        return [...names];
    }
}

/**
 * Wrap a registry as the executor's UI port. The registry speaks `{ok, text}`
 * because it is also driven from hotkeys and dev tooling; the executor speaks the
 * resolver's `Resolution`, so the seam is one function rather than two vocabularies
 * leaking into each other.
 */
export function createNLUiActionPort(
    registry: UiActionRegistry,
): { apply(action: { op: UiActionOp; panelId: string }): Resolution<string> } {
    return {
        apply(action) {
            const result = registry.apply(action.op, action.panelId);
            return result.ok
                ? { kind: 'ok', value: result.text }
                : { kind: 'refuse', reason: result.reason };
        },
    };
}

/**
 * The session's registry. A module singleton like `namedEntityIndex`, for the
 * same reason: the producers (`widget-loader.ts`, `main.ts`) and the consumer
 * (the command console) never meet, and threading one instance between them
 * would mean giving every widget a reference it has no other use for.
 */
export const uiActionRegistry = new UiActionRegistry();
