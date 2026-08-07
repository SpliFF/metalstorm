/**
 * Resolve a command-language unit class ("armour", "infantry", …) to the set
 * of unit-def ids it names, so a macro directive can carry a real
 * `StandingOrderConditions.squad_types` vector instead of an empty one.
 *
 * WHY THIS EXISTS. The command composer's Subject slot has always offered
 * class subjects, and the class was thrown away at compile time: every
 * non-group subject produced `groupId = 0` with no conditions at all, so
 * "armour" and "artillery" sent byte-identical messages and the server matched
 * *any* unit. PLAN-endtoend.md D56.
 *
 * WHERE THE MAPPING LIVES. The taxonomy key is `customparams.ms_class` on the
 * unit def, and the player-facing synonyms are declared once in the game's own
 * `ui/class-vocabulary.json`. That file is game data served over HTTP and the
 * loader for it is still command-language M0 work, so the synonyms the
 * composer's four closed-vocabulary classes need are mirrored below — the
 * mirror is deliberately tiny and named in class-vocabulary.json's own
 * "anti-drift" note. Anything not listed falls through to an exact
 * `ms_class` match, which is what a caller that already speaks the real
 * taxonomy (the free-text accelerator's wider class list) wants.
 */

/** Command-language class name → the `ms_class` values it covers. Only
 *  entries that are NOT already an exact `ms_class` need a row here. */
const CLASS_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
    armour: ['tanks'],
    armor: ['tanks'],
    infantry: ['soldiers'],
    troops: ['soldiers'],
    grunts: ['soldiers'],
    // "air" is not an ms_class — it is the union of the two air classes.
    air: ['fighters', 'bombers'],
    walker: ['mechs'],
    walkers: ['mechs'],
    guns: ['artillery'],
    howitzers: ['artillery'],
    builders: ['engineers'],
    sappers: ['engineers'],
    statics: ['staticdefense'],
    turrets: ['staticdefense'],
};

/** The minimum a def needs to look like for class resolution. */
export interface ClassifiableDef {
    defId: number;
    customParams?: Record<string, string> | undefined;
}

/** The `ms_class` values a command-language class name covers. Lowercased and
 *  trimmed; an unknown name resolves to itself so exact taxonomy keys work. */
export function msClassesFor(className: string): readonly string[] {
    const key = className.trim().toLowerCase();
    if (key === '') return [];
    return CLASS_SYNONYMS[key] ?? [key];
}

/**
 * Unit-def ids whose `customparams.ms_class` falls under `className`.
 *
 * Returns an empty array when the class names nothing in this game's roster —
 * the caller must treat that as "do not send a filter" rather than "match
 * nothing", because an empty `squad_types` is the wire's wildcard and would
 * silently widen the directive to the whole army.
 */
export function resolveUnitClassToDefIds(
    className: string,
    defs: readonly ClassifiableDef[],
): number[] {
    const wanted = new Set(msClassesFor(className));
    if (wanted.size === 0) return [];
    const out: number[] = [];
    for (const def of defs) {
        const cls = def.customParams?.ms_class;
        if (cls && wanted.has(String(cls).trim().toLowerCase())) out.push(def.defId);
    }
    return out;
}
