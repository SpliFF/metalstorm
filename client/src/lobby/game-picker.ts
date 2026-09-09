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
    /// `ai.config.lua`'s `description`, which the route already serves and
    /// the room screen never read.
    description?: string;
    /// PROPOSED: the profiles the plugin ships, read from `ai.config.lua`'s
    /// `profiles` table by AIDiscovery (see docs/reviews/2026-09-10/
    /// war-surfaces.md). Absent on every lobby today, hence the fallback.
    profiles?: AIProfileInfo[];
}

/// One selectable personality of an AI plugin (PLAN-metalstorm-ai.md §3.4).
export interface AIProfileInfo {
    id: string;
    label: string;
    /// The deployment role the profile binds (`roles.lua`).
    role: 'full_side' | 'co_commander' | 'npc';
    /// One line, in the player's terms.
    description: string;
}

/// What each role means to the host adding a seat — roles.lua's policy table
/// said in one sentence each. The role is the fact that decides whether the
/// slot is an OPPONENT, a TEAMMATE or SCENERY, which is the whole question.
export const AI_ROLE_DESCRIPTIONS: Record<AIProfileInfo['role'], string> = {
    full_side: 'Commands a whole side on its own — an opponent, or a stand-in commander.',
    co_commander: 'Fights beside the humans on its side: takes only idle force, spends only its own pool, follows their guidance.',
    npc: 'A minor faction driven by the scenario: raids, tolls and holds its home, dormant when nobody is near.',
};

/// The strategos profiles, until `/api/ai/<game>` publishes them. A
/// documented duplicate of `ai/strategos/profiles/*.lua` (ids, roles) — the
/// plugin lives in a Lua VM the client cannot introspect. Kept in this
/// module rather than in lobby-ui so a slot holding a profile this table
/// does not know is handled by a rule, not by the browser's `<select>`
/// silently showing option 0.
export const STRATEGOS_PROFILE_FALLBACK: readonly AIProfileInfo[] = [
    { id: 'default', label: 'Balanced', role: 'full_side',
      description: 'The reference brain: neutral weights, no extra caution, balanced doctrine.' },
    { id: 'aggressive', label: 'Aggressive', role: 'full_side',
      description: 'Pushes hard and commits on thinner odds; armour doctrine. Still pays authority and lives in the fog.' },
    { id: 'caretaker', label: 'Caretaker', role: 'co_commander',
      description: 'A steward for your side: holds what you built, will not gamble the team pool, takes over fully if every human leaves.' },
    { id: 'mentor', label: 'Mentor (suggest-only)', role: 'co_commander',
      description: 'Suggests instead of acting — posts the move a good commander would make, about once a minute, and spends nothing.' },
    { id: 'npc_raider', label: 'NPC Raider', role: 'npc',
      description: 'Needs a scenario slate (home region, raid targets). Without one it is a plain defensive minor faction.' },
];

/// The profiles offerable for `aiId`: the route's own list when it publishes
/// one, the fallback table for strategos, nothing for every other plugin
/// (the Null AI has no personality to pick).
export function aiProfilesFor(
    aiId: string, ais: readonly AIPickerEntry[] = [],
): readonly AIProfileInfo[] {
    const entry = ais.find(a => a.id === aiId);
    if (entry?.profiles && entry.profiles.length > 0) return entry.profiles;
    return aiId === 'strategos' ? STRATEGOS_PROFILE_FALLBACK : [];
}

export interface AIProfileOption {
    id: string;
    label: string;
    /// The tooltip: role + description, or the reason the entry is odd.
    title: string;
    selected: boolean;
    /// True for the trailing entry that names a profile no table knows.
    unknown: boolean;
}

/// The `<option>` list for a slot's profile dropdown. The empty id is the
/// plugin's own default and comes first. A slot whose stored profile is not
/// in the list — a manifest-created room, a profile renamed since — gets a
/// trailing entry naming it, so the control shows what the slot IS rather
/// than the first thing in the list (the same rule `renderSideOptions` keeps
/// for a team no side offers).
export function aiProfileOptions(
    profiles: readonly AIProfileInfo[], selected: string,
): AIProfileOption[] {
    const out: AIProfileOption[] = [{
        id: '', label: '(default)', title: 'The plugin\'s own default profile.',
        selected: selected === '', unknown: false,
    }];
    for (const p of profiles) {
        out.push({
            id: p.id, label: p.label,
            title: `${AI_ROLE_DESCRIPTIONS[p.role]} ${p.description}`.trim(),
            selected: p.id === selected, unknown: false,
        });
    }
    if (selected !== '' && !profiles.some(p => p.id === selected)) {
        out.push({
            id: selected, label: `${selected} (unknown profile)`,
            title: 'This slot names a profile the plugin does not list. The AI ' +
                   'will fall back to its default at boot.',
            selected: true, unknown: true,
        });
    }
    return out;
}

/// The one-line description under an AI row.
///
/// Three facts, in the order a host reading the roster needs them: is this
/// plugin one the game actually ships, what role does its profile deploy as,
/// and what will it do. An id no list knows is said plainly — a manifest can
/// name any string, and a room whose AI does not exist is a room with one
/// army, which is D19's shape all over again.
export function describeAISlot(
    aiId: string, profile: string, ais: readonly AIPickerEntry[],
): string {
    const entry = ais.find(a => a.id === aiId);
    if (ais.length > 0 && !entry)
        return `Unknown AI “${aiId}” — this game does not ship it; the slot will not command anything.`;
    const profiles = aiProfilesFor(aiId, ais);
    const p = profile ? profiles.find(x => x.id === profile) : undefined;
    if (profile && profiles.length > 0 && !p)
        return `Unknown profile “${profile}” — the AI will use its default.`;
    if (p) return `${p.label} · ${AI_ROLE_DESCRIPTIONS[p.role]} ${p.description}`;
    if (entry?.description) return entry.description;
    return '';
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
