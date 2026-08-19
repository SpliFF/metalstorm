// game-picker — the Create Game dialog's Game row and the host's "Add AI"
// row, as pure functions over the lists `GET /api/games` and
// `GET /api/ai/<game>` return.
//
// WHY THIS IS A MODULE AND NOT METHODS ON LobbyUI. Same reason
// scenario-picker.ts and war-sides.ts are: there is no jsdom in this suite,
// so a rule that lives inside a DOM-writing method cannot be tested, and an
// untested rule drifts. Both rules here are DEFAULTS — what the player gets
// without touching anything — which is precisely the class of behaviour no
// test ever exercises by accident, because every other test sets the value it
// wants first.
//
// PLAN-endtoend.md D26: the first choice a new player makes was wrong in both
// dropdowns. The Game select listed Beyond All Reason and Zero-K — both
// archived 2026-08-02, neither of which starts — with BAR *selected*, because
// the list is alphabetical and the client took `games[0]`. Then, once
// Metalstorm was chosen, the AI select defaulted to "Null AI (engine)",
// because AIDiscovery puts engine AIs first on purpose (a game AI sharing an
// id must be able to override one) and an HTML `<select>` with no `selected`
// attribute takes option 0. So a player who clicked through the defaults got
// an archived game, and a player who fixed that and clicked *Add AI* got an
// opponent that issues no commands.

/// One entry from `GET /api/games`.
export interface GamePickerEntry {
    id: string;
    displayName: string;
    version: string;
    /// True when the game is on disk but does not run. Mirrors
    /// `GameDiscovery::GameInfo::archived`, which reads it from the game's
    /// config. Defaults FALSE on a malformed or older-server entry, matching
    /// the server's own default — silence means playable, and the safe
    /// direction for a parse slip is offering a live game, never hiding one.
    archived: boolean;
    /// Why, in one sentence, for the disabled option's tooltip. May be empty
    /// even when `archived` is true; the label still marks it.
    archivedReason: string;
}

/// One entry from `GET /api/ai/<game>`.
export interface AIPickerEntry {
    id: string;
    displayName: string;
    isEngineProvided: boolean;
}

/// The game the create form should start on: the first PLAYABLE one in the
/// server's order, or null when every discovered game is archived.
///
/// Mirrors `GameDiscovery::DefaultPlayable`. Returning null rather than
/// falling back to an archived game is the same call the server makes — a
/// default that cannot be created is worse than no default, because the
/// player only finds out at the Create button.
export function defaultGameId(games: readonly GamePickerEntry[]): string | null {
    for (const g of games) {
        if (!g.archived) return g.id;
    }
    return null;
}

/// The `<option>` text for one game.
///
/// The version suffix is pre-existing. The archived marker is appended rather
/// than replacing the name because the row still has to be recognisable — a
/// player looking for "Zero-K" needs to find it and *then* learn why it is
/// greyed out, not fail to find it at all.
export function gameOptionLabel(g: GamePickerEntry): string {
    const version = g.version ? ` (${g.version})` : '';
    return g.displayName + version + (g.archived ? ' — archived' : '');
}

/// Whether an option must be rendered `disabled`, and the `title` explaining
/// it. Kept as one function so the two can never disagree: a disabled option
/// with no tooltip is a dead control with no reason attached, which is the
/// defect D26 filed rather than a fix for it.
export function gameOptionState(
    g: GamePickerEntry,
): { disabled: boolean; title: string } {
    if (!g.archived) return { disabled: false, title: '' };
    return {
        disabled: true,
        title: g.archivedReason
            || 'This game is archived and cannot be started.',
    };
}

/// The AI a fresh "Add AI" row should start on: the first one the GAME ships,
/// falling back to the first entry (an engine AI) when it ships none.
///
/// The fallback is not a defect — Paper Tanks ships no AI, and for it "Null
/// AI" genuinely is the only answer. The rule is only ever "prefer the game's
/// own", never "refuse the engine's".
export function defaultAIId(ais: readonly AIPickerEntry[]): string | null {
    for (const ai of ais) {
        if (!ai.isEngineProvided) return ai.id;
    }
    return ais.length > 0 ? ais[0].id : null;
}
