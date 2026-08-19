// AI veto-loop checks — PLAN-ai-synced-write.md **task 5** (SG1's exit test).
//
// The loop under test is four hops long and every hop already has unit
// coverage; what had never been observed is the loop CLOSING on a real sim:
//
//   strategos actuator pushes `ai.intent` (goalId) ──▶ engine LuaMsg drain
//   ──▶ game_ai_guidance consumes the tag onto the directive it annotates
//   ──▶ publishes `guidance_<team>_intent_<i>_goal_id`
//   ──▶ a HUMAN's `guidance.veto` carrying that id ──▶ planner stops proposing it.
//
// Two things about the verdict are load-bearing and neither is obvious:
//
//  1. **"No further directives for that goal" is trivially true of a dead AI.**
//     An AI that ran out of authority, crashed its plugin, or lost its pool
//     issues nothing at all and passes a naive check. So the verdict requires
//     the AI to have kept issuing directives after the veto (`freshAfter`), and
//     reports VACUOUS rather than PASS when it did not.
//  2. **The intent list is a rolling window, not a log.** Entries expire after
//     INTENT_TTL_FRAMES (600) and new ones are PREPENDED, so the vetoed id
//     disappearing from the published list is ambiguous on its own — it may
//     have simply aged out. What is unambiguous is the id never appearing at
//     the HEAD of a later sample, because only a fresh charge can put it there.
//
// Pure functions over sampled readings (no fs, no spawn) — the same pure-core
// split churn-checks.mjs and fixture-checks.mjs use, so the verdict logic is
// unit-tested without a server.

/** One `/api/exec` sample of the published guidance state. */
/* eslint-disable jsdoc/valid-types */
/**
 * @typedef {object} IntentSample
 * @property {number} frame        sim frame the sample was read at
 * @property {string[]} goalIds    published intent goal ids, newest FIRST ('' = untagged)
 * @property {string[]} vetoKeys   `guidance_<team>_veto_keys`, split
 */

/** Parse the packed reading the runner's Lua one-liner returns.
 *
 * Shape: `frame|goalId,goalId,…|vetoKey,vetoKey,…` — deliberately flat, because
 * the exec bridge pretty-prints its return value and anything nested arrives
 * quote-mangled (docs/debugging-console.md; the trap that has produced silent
 * false negatives twice). An empty list is the empty string, and an untagged
 * intent line is an empty element, so `count` cannot be recovered from the
 * list length alone — the runner asserts on ids, which is what the veto uses.
 */
export function parseSample(text) {
    const [frameStr = '', goals = '', vetoes = ''] = String(text ?? '').split('|');
    const split = (s) => (s === '' ? [] : s.split(','));
    return {
        frame: Number.parseInt(frameStr, 10) || 0,
        goalIds: split(goals),
        vetoKeys: split(vetoes),
    };
}

/** The newest published goal id, or '' when the head line carries no tag. */
export function headGoalId(sample) {
    return sample?.goalIds?.[0] ?? '';
}

/**
 * Pick the goal to veto: the id the AI is directing MOST persistently, so the
 * assertion has something to bite on. A goal seen once may not be re-proposed
 * anyway, and vetoing that one would pass whether or not the veto worked.
 *
 * Returns null when no sample carries a tagged line at all — which is itself a
 * finding, not a flake (a co-commander with an empty pool charges nothing, so
 * RecordIntent never fires and there is no goal id to veto; see §6 task 5).
 */
export function pickVetoTarget(samples) {
    const counts = new Map();
    for (const s of samples ?? []) {
        // Counted ONCE per sample, not once per line. A goal the AI charged
        // four times in one tick occupies four lines of a single sample, and
        // counting lines would let a goal seen in one instant outrank one the
        // AI has been pursuing across the whole window — which is the opposite
        // of what this picks for. `samples` therefore means "still being
        // directed later", which is the property the assertion needs.
        for (const id of new Set((s.goalIds ?? []).filter(Boolean))) {
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
    }
    let best = null;
    for (const [id, n] of counts) {
        // Ties break on the id so a re-run picks the same target: the arm has
        // to be reproducible for a neutralisation to mean anything.
        if (!best || n > best.samples || (n === best.samples && id < best.id)) {
            best = { id, samples: n };
        }
    }
    return best;
}

/**
 * The verdict.
 *
 * @param {object} arg
 * @param {string} arg.vetoedGoalId
 * @param {number} arg.vetoFrame              frame the veto was accepted at
 * @param {IntentSample[]} arg.before         samples taken before the veto
 * @param {IntentSample[]} arg.after          samples taken after it
 * @param {number} arg.strategicTickFrames    the AI's tick period (150)
 * @param {number} arg.requiredTicks          how many must be observed (2)
 * @param {string[]} arg.plannerVetoReports   ids the planner logged as veto-excluded
 * @returns {{status:'pass'|'fail'|'vacuous', problems:string[], facts:object}}
 */
export function vetoLoopVerdict({
    vetoedGoalId, vetoFrame, before = [], after = [],
    strategicTickFrames = 150, requiredTicks = 2, plannerVetoReports = [],
}) {
    const problems = [];
    const directedBefore = before.filter((s) => (s.goalIds ?? []).includes(vetoedGoalId)).length;

    // The blacklist has to be readable by the planner, which reads it out of
    // `veto_keys` — not out of the store it was written to. A veto that set the
    // store and never published is invisible to the AI (picture.lua only ever
    // sees rulesParams), and looks identical to a working one from the gadget's
    // side. That is why this is asserted on the PUBLISHED list.
    const published = after.some((s) => (s.vetoKeys ?? []).includes(vetoedGoalId));

    // Every id that reached the HEAD of a post-veto sample: a fresh charge, the
    // only thing that can prepend. Ages-out is not confusable with this.
    const freshAfter = [];
    for (const s of after) {
        const head = headGoalId(s);
        if (head && !freshAfter.includes(head)) freshAfter.push(head);
    }
    const reoffended = after.filter((s) => headGoalId(s) === vetoedGoalId);
    const framesObserved = after.length
        ? Math.max(0, after[after.length - 1].frame - vetoFrame) : 0;
    const ticksObserved = Math.floor(framesObserved / strategicTickFrames);

    // The planner's own report that it consulted the veto (main.lua's tick line
    // `vetoed=<ids>`). Without this the assertion below is nearly inert: the
    // top-ranked goal rotates every tick or two anyway, so a planner that
    // ignored the veto entirely still stops directing the vetoed goal most of
    // the time — measured, with the check commented out, on 2026-08-14.
    const plannerSaw = (plannerVetoReports ?? []).includes(vetoedGoalId);

    const facts = {
        vetoedGoalId, vetoFrame, directedBefore, publishedInVetoKeys: published,
        plannerReportedExclusion: plannerSaw,
        freshGoalsAfter: freshAfter, reoffendingSamples: reoffended.length,
        framesObserved, ticksObserved, requiredTicks,
        samplesBefore: before.length, samplesAfter: after.length,
    };

    // ── Vacuity gates first: an arm that could not have failed must not pass ──
    if (!vetoedGoalId) {
        return { status: 'vacuous', facts, problems: ['no goal id was ever published to veto'] };
    }
    if (directedBefore === 0) {
        return {
            status: 'vacuous', facts,
            problems: [`the AI never directed '${vetoedGoalId}' before the veto — `
                + 'a goal it was not pursuing cannot be observed to stop'],
        };
    }
    if (ticksObserved < requiredTicks) {
        return {
            status: 'vacuous', facts,
            problems: [`only ${ticksObserved} strategic tick(s) observed after the veto `
                + `(${framesObserved} frames); the acceptance bar is ${requiredTicks}`],
        };
    }
    if (freshAfter.length === 0) {
        return {
            status: 'vacuous', facts,
            problems: ['the AI issued no charged directive at all after the veto — '
                + '"it stopped proposing the vetoed goal" is true of an AI that stopped '
                + 'proposing anything, so this window proves nothing'],
        };
    }

    // ── The assertions ──
    if (!published) {
        problems.push(`'${vetoedGoalId}' never appeared in guidance veto_keys — the human's `
            + 'veto did not reach the store the planner reads');
    }
    if (reoffended.length) {
        problems.push(`'${vetoedGoalId}' was directed again after the veto `
            + `(${reoffended.length} sample(s) with it at the head of the intent list)`);
    }
    if (!plannerSaw) {
        problems.push(`the planner never reported excluding '${vetoedGoalId}' — its tick line `
            + 'carries no `vetoed=` naming it, so nothing here shows the veto reached the '
            + 'planner\'s decision rather than the goal simply falling out of favour');
    }
    return { status: problems.length ? 'fail' : 'pass', facts, problems };
}

/**
 * Push order (task 5(b)) over `/api/journal` rows.
 *
 * The correlation depends on `ai.intent` being pushed BEFORE the directive it
 * annotates, in the same drain — `_issueTagged` guarantees it and the gadget
 * refuses a tag from any other frame. Read off the journal: every `lua-msg`
 * record must be followed, for the same player, by a directive-shaped record in
 * the SAME frame, and never by another `lua-msg`.
 *
 * Takes an array of BLOCKS, each a run of consecutive records, because
 * `/api/journal` publishes the ring's head and tail and not the middle. Pairing
 * across that seam invents an adjacency the stream never had: measured on
 * 2026-08-14, head ended at seq 20 / frame 449 and tail began at seq 39 /
 * frame 899, and the concatenated list read as a tag whose directive arrived
 * 450 frames late — a fabricated failure of the very property under test.
 * Adjacency is only meaningful inside a block.
 *
 * A window with no `lua-msg` record at all is `vacuous`: the AI may simply not
 * have tagged anything inside the published rows.
 */
export function pushOrderVerdict(blocks = []) {
    // A single flat array is accepted as one block, so a caller with the whole
    // stream does not have to wrap it.
    const asBlocks = Array.isArray(blocks[0]) ? blocks : [blocks];
    const problems = [];
    let pairs = 0;
    let tagCount = 0;
    let aiCount = 0;
    const verbs = new Set();
    for (const block of asBlocks) {
        const ai = (block ?? []).filter((r) => r.kind === 'ai-command');
        aiCount += ai.length;
        for (const r of ai) verbs.add(r.verb);
        for (const tag of ai.filter((r) => r.verb === 'lua-msg')) {
            tagCount++;
            const next = ai.find((r) => r.seq > tag.seq && r.playerId === tag.playerId);
            if (!next) continue;                   // the block ends on the tag; not a defect
            if (next.verb === 'lua-msg') {
                problems.push(`player ${tag.playerId}'s ai.intent at seq ${tag.seq} is followed by `
                    + `another ai.intent (seq ${next.seq}) — a tag with no directive leaves a `
                    + 'pending goal id for the next directive to steal');
                continue;
            }
            if (next.frame !== tag.frame) {
                problems.push(`player ${tag.playerId}'s ai.intent at frame ${tag.frame} is followed `
                    + `by a directive at frame ${next.frame} — the gadget consumes a tag only in `
                    + 'the frame it was stamped, so this one annotates nothing');
                continue;
            }
            pairs++;
        }
    }
    const facts = {
        aiRecords: aiCount, tagRecords: tagCount, orderedPairs: pairs,
        blocks: asBlocks.length, verbs: [...verbs],
    };
    if (!tagCount) {
        return {
            status: 'vacuous', facts,
            problems: ['no ai.intent (lua-msg) record in the journal window — nothing to '
                + 'inspect the order of'],
        };
    }
    return { status: problems.length ? 'fail' : 'pass', facts, problems };
}
