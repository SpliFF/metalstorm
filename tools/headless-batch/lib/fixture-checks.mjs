// Non-vacuity checks for a headless stats dump — PLAN-replay.md T2-c / T3-d.
//
// The bug these exist to make impossible: the landed determinism CI fixture
// ran `basic_ai` on a game that ships no start units, so every one of its 30
// snapshots recorded `numUnits: 0`. Both runs of the pair-run agreed perfectly
// and the gate went green for weeks while testing nothing but the synced RNG
// stream — it could not have caught a movement, collision, damage or
// command-ordering divergence, which is the entire class of regression the
// determinism claim is about.
//
// A hash-equality gate cannot notice that it is comparing two empty worlds.
// So the fixture's *content* is asserted separately and up front: if a dump
// carries no units, no damage and no deaths, the run is rejected as vacuous
// BEFORE any hash is compared, and the failure names which part was empty.
//
// Pure functions over a parsed dump object (no fs, no child_process) so
// test/fixture-checks.test.mjs can cover them without a server binary — the
// same pure-core/wiring split HeadlessRun.{h,cpp} and matrix.mjs use.

// Sums one per-team numeric field across a snapshot's `teams` array.
function teamSum(snapshot, field) {
    let total = 0;
    for (const t of snapshot?.teams ?? []) {
        const v = t?.[field];
        if (typeof v === 'number' && Number.isFinite(v)) total += v;
    }
    return total;
}

// Peak value of a per-team field over the whole run. Peak rather than final:
// a run whose armies annihilate each other ends with numUnits back at 0, and
// that run exercised *more* sim than one that ended with units alive.
export function peakTeamSum(dump, field) {
    let peak = 0;
    for (const s of dump?.snapshots ?? []) peak = Math.max(peak, teamSum(s, field));
    return peak;
}

// What a fixture must demonstrate before its hash track means anything.
// `deaths` is deliberately included: units that exist and shoot but never die
// leave the destruction/removal path — a notorious source of iteration-order
// nondeterminism — completely uncovered.
export const DEFAULT_REQUIREMENTS = {
    units: 1,    // at least one unit existed at some point
    damage: 1,   // at least one point of damage was dealt
    deaths: 1,   // at least one unit was destroyed
};

// Returns { ok, measured, problems[] }. Never throws on a malformed dump —
// a dump with no `snapshots` array measures as all-zero and fails loudly,
// which is the correct verdict for "the run produced nothing".
export function checkFixtureNonVacuous(dump, requirements = DEFAULT_REQUIREMENTS) {
    const measured = {
        snapshots: dump?.snapshots?.length ?? 0,
        units: peakTeamSum(dump, 'numUnits'),
        damage: peakTeamSum(dump, 'damageDealt'),
        deaths: peakTeamSum(dump, 'unitsDied'),
    };

    const problems = [];
    if (measured.snapshots === 0)
        problems.push('the dump has no snapshots at all (stateHashEvery unset, or the run never ticked)');
    if (measured.units < requirements.units)
        problems.push(`peak unit count ${measured.units} < ${requirements.units} — the state hash folds an EMPTY unit list, so it only covers the RNG stream`);
    if (measured.damage < requirements.damage)
        problems.push(`peak damage dealt ${measured.damage} < ${requirements.damage} — no combat happened, so weapons/projectiles/damage are untested`);
    if (measured.deaths < requirements.deaths)
        problems.push(`peak units died ${measured.deaths} < ${requirements.deaths} — nothing was destroyed, so the unit-removal path is untested`);

    return { ok: problems.length === 0, measured, problems };
}

// One-line summary for run logs.
export function describeFixture(measured) {
    return `snapshots=${measured.snapshots} peakUnits=${measured.units} ` +
           `peakDamage=${Math.round(measured.damage)} peakDeaths=${measured.deaths}`;
}
