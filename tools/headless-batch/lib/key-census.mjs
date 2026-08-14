// Key census — PLAN-long-uptime.md **T4-1e**: not how many rulesParams keys a
// session mints, but WHICH.
//
// T4-1a bounded S1 by shape (a sawtooth is bounded iff its peaks are) and left
// the question the bound depends on open: 8.1 assigned ids per churn cycle is a
// rate, and a rate says nothing about whether the population is bounded. The
// two answers have opposite consequences —
//
//   * a key that names a RING SLOT (`warlog_<slot>_kind`, `authority_event_
//     <slot>_amount`) is minted once and reused forever; the count converges on
//     ring size, and the 512-dead compaction floor is never approached.
//   * a key that names a MONOTONIC ID (`objective_<n>_state`, `parley_<n>_kind`)
//     or a PLAYER (`score_<playerNum>_earned`) mints a fresh family per
//     occurrence, and the population grows with the length of the campaign or
//     with the number of humans who ever played. That is what stands between a
//     weeks-long war and the 16-bit id space.
//
// So the census groups keys by SHAPE: the key with every varying token replaced
// by a placeholder. A shape whose member count stands still across a window is
// bounded by construction; a shape that gains members every cycle is the one to
// argue about, and the report names it rather than reporting one number for all
// of them.
//
// Pure — no node, no I/O — so `run-wire-churn.mjs`'s raw output and a unit test
// reach the same code.

/**
 * The shape of one key: digit runs become `<n>`, so `objective_17_state` and
 * `objective_18_state` are one shape and `war_state` is its own.
 *
 * Digits are the only tokeniser used, deliberately. Every varying token this
 * game actually embeds is numeric (unit id, team id, playerNum, sequence, ring
 * slot) — see the emitter census in PLAN-long-uptime §17 — while the NAMED
 * varying tokens (`region_<key>_x`, `town_<key>_name`, `landmark_<name>_x`) are
 * drawn from the map and are bounded by it. Folding those together would hide
 * exactly the distinction the census exists to draw, so they stay distinct
 * shapes and their count is their own evidence.
 */
export function keyShape(key) {
    return String(key).replace(/\d+/g, '<n>');
}

/**
 * Group a flat key list into shapes.
 * Returns shapes sorted by member count descending, then by name, so two runs
 * of the same population print identically.
 */
export function censusKeys(keys) {
    const byShape = new Map();
    for (const key of keys) {
        const shape = keyShape(key);
        let e = byShape.get(shape);
        if (!e) { e = { shape, count: 0, example: key }; byShape.set(shape, e); }
        e.count++;
        if (key < e.example) e.example = key;
    }
    const shapes = [...byShape.values()].sort(
        (a, b) => b.count - a.count || a.shape.localeCompare(b.shape));
    return { total: keys.length, shapes };
}

/**
 * The census proper: what a window of churn cycles minted.
 *
 * `cycles` is the driver's per-cycle record — `{ cycle, rev, size, newKeys }`,
 * where `newKeys` is every key in that cycle's dictionary that no earlier cycle
 * had seen. The FIRST cycle's newKeys is the whole dictionary at connect (the
 * world's static keys plus whatever set-up minted), so it is reported separately
 * as the baseline: counting it as churn would attribute the map to the clients.
 *
 * The verdict per shape:
 *   `static`  — present in the baseline, gained nothing during the window
 *   `growing` — gained members after the baseline cycle, with `perCycle`
 *   `new`     — first seen after the baseline (a shape the churn itself created)
 */
export function censusChurn(cycles) {
    const ordered = [...cycles].sort((a, b) => a.cycle - b.cycle);
    const baseline = ordered[0] ?? null;
    const rest = ordered.slice(1);

    const baselineCensus = censusKeys(baseline?.newKeys ?? []);
    const baselineShapes = new Map(baselineCensus.shapes.map((s) => [s.shape, s.count]));

    /** Shapes that gained members after the baseline cycle. */
    const grown = new Map();
    let mintedDuringWindow = 0;
    for (const c of rest) {
        for (const key of c.newKeys ?? []) {
            mintedDuringWindow++;
            const shape = keyShape(key);
            let e = grown.get(shape);
            if (!e) {
                e = {
                    shape, minted: 0, example: key,
                    verdict: baselineShapes.has(shape) ? 'growing' : 'new',
                    baselineCount: baselineShapes.get(shape) ?? 0,
                    cycles: new Set(),
                };
                grown.set(shape, e);
            }
            e.minted++;
            e.cycles.add(c.cycle);
            if (key < e.example) e.example = key;
        }
    }

    // Cycles AFTER the baseline are what a per-cycle rate may be divided by: the
    // baseline cycle minted the world, not a cycle's worth of churn.
    const churnCycles = rest.length;
    const growing = [...grown.values()]
        .map((e) => ({
            shape: e.shape,
            verdict: e.verdict,
            baselineCount: e.baselineCount,
            minted: e.minted,
            /** Cycles in which this shape gained at least one key. */
            activeCycles: e.cycles.size,
            perCycle: churnCycles ? e.minted / churnCycles : 0,
            example: e.example,
        }))
        .sort((a, b) => b.minted - a.minted || a.shape.localeCompare(b.shape));

    const staticShapes = baselineCensus.shapes
        .filter((s) => !grown.has(s.shape))
        .map((s) => ({ ...s, verdict: 'static' }));

    // WHEN a key was minted decides what the per-cycle rate means, and the two
    // readings are not close. Measured 2026-08-14: 368 keys over 65 cycles reads
    // as 5.66/cycle, and every one of them arrived in cycles 1-8 — the war
    // starting up — with 57 consecutive later cycles minting zero. A rate
    // divided over the whole window would have described a growing dictionary
    // that had in fact been flat for two and a half minutes.
    const mintedByCycle = ordered.map((c) => ({
        cycle: c.cycle, minted: (c.newKeys ?? []).length, size: c.size,
    }));
    const lastMinting = [...mintedByCycle].reverse().find((c) => c.minted > 0) ?? null;
    const quietTailCycles = lastMinting
        ? ordered[ordered.length - 1].cycle - lastMinting.cycle
        : Math.max(0, ordered.length - 1);

    return {
        baselineCycle: baseline?.cycle ?? null,
        baselineKeys: baselineCensus.total,
        baselineShapes: baselineCensus.shapes.length,
        churnCycles,
        mintedDuringWindow,
        keysPerCycle: churnCycles ? mintedDuringWindow / churnCycles : 0,
        growing,
        static: staticShapes,
        mintedByCycle,
        /** The last cycle that minted anything, and how many cycles of churn ran
         *  after it without minting. A long quiet tail says the population is
         *  set by the war's start-up, not by the churn. */
        lastMintingCycle: lastMinting?.cycle ?? null,
        quietTailCycles,
        /** Every dictionary revision observed, so a compaction inside the window
         *  (which RENUMBERS ids and would make a naive id-based census lie) is
         *  visible in the record rather than silently folded in. */
        revs: ordered.map((c) => c.rev),
        finalSize: ordered.length ? ordered[ordered.length - 1].size : 0,
    };
}

/** Human-readable census, one line per shape that moved. Bounded output: shapes,
 *  not keys — the key list is in the JSON beside it. */
export function formatCensus(census, { topStatic = 5 } = {}) {
    const lines = [];
    lines.push(`  baseline: ${census.baselineKeys} key(s) in ${census.baselineShapes} shape(s) `
        + `at cycle ${census.baselineCycle}`);
    lines.push(`  window:   ${census.mintedDuringWindow} key(s) minted over ${census.churnCycles} `
        + `later cycle(s) = ${census.keysPerCycle.toFixed(2)}/cycle`);
    lines.push(census.lastMintingCycle === null
        ? `  timeline: nothing was minted after the baseline cycle `
            + `(${census.quietTailCycles} quiet cycle(s))`
        : `  timeline: last mint at cycle ${census.lastMintingCycle}, then `
            + `${census.quietTailCycles} cycle(s) of churn minting nothing `
            + `(dictionary flat at ${census.finalSize})`);
    if (!census.growing.length) {
        lines.push('  no shape gained a key after the baseline cycle — every key the '
            + 'window used was already interned');
    }
    for (const g of census.growing) {
        lines.push(`  ${g.verdict === 'new' ? 'NEW    ' : 'GROWING'} ${g.shape}: `
            + `+${g.minted} (${g.perCycle.toFixed(2)}/cycle, ${g.activeCycles} active cycle(s), `
            + `baseline ${g.baselineCount}) e.g. ${g.example}`);
    }
    const top = census.static.slice(0, topStatic);
    if (top.length) {
        lines.push(`  static shapes (top ${top.length} of ${census.static.length} by size): `
            + top.map((s) => `${s.shape}×${s.count}`).join(', '));
    }
    return lines.join('\n');
}
