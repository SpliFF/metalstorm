// capture_subject — the server-side half of the "show me this" primitive.
//
// The BROWSER half (framing, capture, black-frame retry) is one relay call
// into `window.test.captureSubject()`. This file owns everything that must
// happen on the GAME SERVER around it, and — more importantly — the ORDER.
//
// Three ordering facts, each of which has cost a fire:
//
//  1. **A paused sim does not stream fresh spawns.** Spawn → pause → capture
//     looks obviously right and produces a picture of empty ground: the unit
//     exists in the sim, but the entity snapshot that would carry it to the
//     browser is never sent, because sending it is something the tick does.
//     The order is spawn → let the stream settle → pause.
//
//  2. **The same is true of a fog-of-war reveal.** `los on` flips
//     `globalLOS`, but the client only learns about the newly-visible units
//     on the next entity snapshot. Reveal before the pause, not after.
//
//  3. **Restoring is not "undo everything".** A sim that was ALREADY paused
//     when we arrived must stay paused; global LOS that was already on must
//     stay on. Otherwise a capture silently un-pauses somebody's frozen
//     scene, which is precisely the "the target moved" failure this tool
//     exists to remove.
//
// Everything here is pure — the handler in server.js executes the plan.

/** Server verbs, in the order the plan emits them. */
export const PHASE_OPS = ['cheats', 'spawn', 'los', 'settle', 'pause', 'capture'];

/** Default dwell (ms) between a spawn/reveal and the pause, so the entity
 *  snapshot carrying the change reaches the browser first. Two 10 Hz-ish
 *  snapshot periods plus slack. */
export const DEFAULT_STREAM_SETTLE_MS = 600;

/** Relay budget for the composite. It resolves, frames, dwells and may take
 *  three shots, so the 10 s default the other relay tools use is too tight. */
export const DEFAULT_RELAY_TIMEOUT_MS = 45000;

/**
 * `los status` → per-ally-team booleans.
 * The verb answers `ally0=on ally1=off`; the JSON form answers
 * `{"globalLos":[true,false]}`. Accept both, and say so when neither parses —
 * guessing "off" here would make us turn LOS off on the way out of a game
 * that had it on.
 */
export function parseLosStatus(output) {
    if (output == null) return { known: false, teams: [], allOn: false, anyOn: false };
    const text = String(output).trim();
    let teams = null;
    try {
        const j = JSON.parse(text);
        if (Array.isArray(j?.globalLos)) teams = j.globalLos.map(Boolean);
    } catch { /* fall through to the text form */ }
    if (!teams) {
        const m = [...text.matchAll(/ally(\d+)\s*=\s*(on|off|true|false|1|0)/gi)];
        if (m.length) {
            teams = [];
            for (const [, idx, val] of m) {
                teams[Number(idx)] = /^(on|true|1)$/i.test(val);
            }
            teams = [...teams].map(Boolean);
        }
    }
    if (!teams) return { known: false, teams: [], allOn: false, anyOn: false };
    return {
        known: true,
        teams,
        allOn: teams.length > 0 && teams.every(Boolean),
        anyOn: teams.some(Boolean),
    };
}

/**
 * Unit ids out of a spawn reply. The JSON verb answers `{ids:[…]}` or
 * `{unitIds:[…]}` depending on binary vintage; the legacy text form answers
 * `spawned 1 unit(s): 42`. A reply we cannot parse is an empty list, never a
 * fabricated id.
 */
export function parseSpawnIds(reply) {
    if (reply == null) return [];
    if (typeof reply === 'object') {
        for (const key of ['ids', 'unitIds', 'units', 'spawned']) {
            const v = reply[key];
            if (Array.isArray(v)) {
                const ids = v.map((e) => (typeof e === 'object' && e ? e.id : e))
                    .map(Number).filter(Number.isFinite);
                if (ids.length) return ids;
            }
        }
        if (Number.isFinite(Number(reply.id))) return [Number(reply.id)];
        return [];
    }
    // The leading \d matters: `error: unknown unit def` also has a colon, and a
    // laxer pattern captured the whitespace after it and turned it into id 0.
    const m = String(reply).match(/:\s*(\d[\d,\s]*)/);
    if (!m) return [];
    return m[1].split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
}

/** Which subject selectors are mutually exclusive, and what each needs. */
const SUBJECT_KEYS = ['unitId', 'unitIds', 'def', 'position', 'area'];

/**
 * Validate the tool arguments beyond what the JSON schema can express.
 * Returns an error string, or null.
 */
/**
 * Names a caller plausibly reaches for, that the schema's near-miss check
 * cannot catch (it only flags edit-distance-1 typos on short names). Silently
 * ignoring `defName` — which is what `spawn_unit` calls the same field — would
 * read as "capture_subject needs a subject", which is a lie about the cause.
 */
const ARG_ALIASES = {
    defName: 'def', unitDef: 'def', name: 'def',
    pos: 'position', point: 'position', target: 'position',
    ids: 'unitIds', units: 'unitIds',
};

export function validateCaptureArgs(args = {}) {
    for (const [wrong, right] of Object.entries(ARG_ALIASES)) {
        if (args[wrong] !== undefined && args[right] === undefined) {
            return `capture_subject has no argument "${wrong}" — use "${right}".`;
        }
    }
    if (args.x !== undefined && args.position === undefined && args.area === undefined) {
        return 'capture_subject takes coordinates as position:{x,z} (or area:{x1,z1,x2,z2}), not bare x/z.';
    }
    const given = SUBJECT_KEYS.filter((k) => args[k] !== undefined && args[k] !== null);
    if (given.length === 0) {
        return 'capture_subject needs a subject: unitId, unitIds, def, position {x,z} or area {x1,z1,x2,z2}.';
    }
    if (given.length > 1) {
        return `capture_subject takes ONE subject; got ${given.join(' + ')}.`;
    }
    if (args.position && !(Number.isFinite(args.position.x) && Number.isFinite(args.position.z))) {
        return 'position needs numeric x and z (y and radius are optional).';
    }
    if (args.area) {
        const a = args.area;
        for (const k of ['x1', 'z1', 'x2', 'z2']) {
            if (!Number.isFinite(a[k])) return `area needs numeric ${k}.`;
        }
    }
    if (args.spawn) {
        if (!args.def) return 'spawn:true needs `def` — that is what gets spawned.';
        if (!Number.isFinite(args.spawn.x) || !Number.isFinite(args.spawn.z)) {
            return 'spawn needs numeric x and z.';
        }
    }
    if (args.unitIds && (!Array.isArray(args.unitIds) || args.unitIds.length === 0)) {
        return 'unitIds must be a non-empty array of unit ids.';
    }
    return null;
}

/**
 * The ordered plan.
 *
 * `state` is what we observed BEFORE touching anything:
 *   { simPaused: boolean|null, los: <parseLosStatus result> }
 * A null/unknown observation is treated as "do not restore what you cannot
 * prove you changed" — the plan simply omits that restore step and says why.
 *
 * Returns `{ pre: [...], post: [...], notes: [...] }`. `pre` runs before the
 * relay call, `post` after it (and after a failure — the handler runs `post`
 * in a finally).
 */
export function planCapture(args = {}, state = {}) {
    const pre = [];
    const post = [];
    const notes = [];
    const settleMs = Number.isFinite(args.streamSettleMs)
        ? Math.max(0, args.streamSettleMs) : DEFAULT_STREAM_SETTLE_MS;

    // — spawn (admin path) —
    if (args.spawn) {
        // Spawning on a foreign team, or at all in a non-cheat game, needs the
        // cheat flag; we turn it back off only if we turned it on.
        if (state.cheatsOn === false) {
            pre.push({ op: 'cheats', enable: true });
            post.push({ op: 'cheats', enable: false });
        }
        pre.push({
            op: 'spawn', def: args.def,
            x: args.spawn.x, z: args.spawn.z,
            team: args.spawn.team ?? 0, count: args.spawn.count ?? 1,
        });
    }

    // — reveal —
    // 'auto' (the default) reveals only when it is not already revealed, and
    // restores. false never touches LOS. true forces it on and restores.
    const reveal = args.reveal === undefined ? 'auto' : args.reveal;
    if (reveal !== false && reveal !== 'off') {
        if (!state.los?.known) {
            notes.push('global-LOS state could not be read; leaving LOS untouched'
                + ' — a fogged subject will come back as a black-frame diagnosis');
        } else if (state.los.allOn) {
            notes.push('global LOS was already on — left as found');
        } else {
            pre.push({ op: 'los', enable: true });
            post.push({ op: 'los', enable: false });
        }
    }

    // — settle —
    // Only meaningful when we changed something the sim has to stream out.
    const changedWorld = pre.some((s) => s.op === 'spawn' || s.op === 'los');
    if (changedWorld && settleMs > 0) {
        pre.push({ op: 'settle', ms: settleMs,
                   why: 'a paused sim streams no fresh spawns or reveals' });
    }

    // — pause — always LAST of the pre steps.
    const pause = args.pause !== false;
    if (pause) {
        if (state.simPaused === true) {
            notes.push('sim was already paused — left as found');
        } else {
            pre.push({ op: 'pause', paused: true });
            post.push({ op: 'pause', paused: false });
        }
    }

    post.reverse();   // restore in reverse order of application
    return { pre, post, notes };
}

/** The one-liner the plan turned into, for the metadata block. */
export function describePlan(plan) {
    const step = (s) => {
        switch (s.op) {
            case 'cheats': return `cheats ${s.enable ? 'on' : 'off'}`;
            case 'spawn':  return `spawn ${s.def}×${s.count} @ ${s.x},${s.z} (team ${s.team})`;
            case 'los':    return `los ${s.enable ? 'on' : 'off'}`;
            case 'settle': return `wait ${s.ms}ms for the stream`;
            case 'pause':  return s.paused ? 'pause sim' : 'resume sim';
            default:       return s.op;
        }
    };
    const pre = plan.pre.map(step);
    const post = plan.post.map(step);
    return [...pre, 'capture', ...post].join(' → ');
}

/**
 * Build the `window.test` expression for the relay. The relay's `test` target
 * evaluates with the harness members in scope, so no `window.test.` prefix.
 */
export function buildHarnessCall(args = {}) {
    const spec = {};
    if (args.unitId !== undefined) spec.unitId = args.unitId;
    if (args.unitIds !== undefined) spec.unitIds = args.unitIds;
    if (args.def !== undefined) spec.def = args.def;
    if (args.position !== undefined) spec.position = args.position;
    if (args.area !== undefined) spec.area = args.area;
    for (const k of ['angle', 'yawDeg', 'pitchDeg', 'fill', 'maxDim', 'quality',
                     'format', 'retries', 'luminanceFloor', 'settleMs',
                     'resolveTimeoutMs', 'holdRender', 'restore']) {
        if (args[k] !== undefined) spec[k] = args[k];
    }
    // maxDim is clamped for the same reason client_screenshot clamps it: the
    // relay reply has to fit the 4 MB wire cap.
    if (spec.maxDim !== undefined) {
        spec.maxDim = Math.max(64, Math.min(2048, Number(spec.maxDim)));
    }
    // The harness only uses `revealed` to word its black-frame diagnosis, so
    // tell it the truth about what we did on the server side.
    spec.revealed = args.__revealed === true;
    return `captureSubject(${JSON.stringify(spec)})`;
}

/**
 * Metadata text block. Deliberately leads with the VERDICT: a caller who reads
 * only the first line must still learn that the image is a diagnosis rather
 * than a deliverable.
 */
export function formatCaptureMeta(result, ctx = {}) {
    const lines = [];
    const ok = result?.ok !== false;
    lines.push(ok ? 'capture: OK' : 'capture: UNUSABLE — read `diagnosis` below, do not trust the image');
    if (result?.diagnosis) lines.push(`diagnosis: ${result.diagnosis}`);
    for (const w of result?.warnings ?? []) lines.push(`warning: ${w}`);
    for (const n of ctx.notes ?? []) lines.push(`note: ${n}`);

    const s = result?.subject;
    if (s) {
        const who = s.def ? `def ${s.def}`
            : s.unitIds?.length > 1 ? `units ${s.unitIds.join(',')}`
            : s.unitId != null ? `unit ${s.unitId}`
            : s.kind;
        lines.push(`subject: ${who} — ${s.metresAcross?.toFixed(1)} m across`
            + ` (r=${s.sphere?.radius?.toFixed(0)} elmos) at`
            + ` ${s.sphere?.x?.toFixed(0)}, ${s.sphere?.y?.toFixed(0)}, ${s.sphere?.z?.toFixed(0)}`
            + `, model=${s.hasModel === true ? 'loaded' : s.hasModel === false ? 'FALLBACK' : 'loading'}`);
    }
    const f = result?.framing;
    if (f) {
        lines.push(`framing: ${f.angle} yaw=${f.yawDeg}° pitch=${f.pitchDeg}°`
            + ` fill=${f.fill} distance=${f.distance?.toFixed(0)} elmos`);
    }
    if (result?.attempts?.length > 1) {
        lines.push(`attempts: ${result.attempts.length} (luminance `
            + result.attempts.map((a) => a.stats?.mean?.toFixed(1) ?? '?').join(' → ') + ')');
    }
    lines.push(`frame: gameFrame=${result?.gameFrame} frameId=${result?.frameId}`
        + ` size=${result?.width}×${result?.height}`);
    if (ctx.plan) lines.push(`plan: ${ctx.plan}`);
    if (ctx.clientId !== undefined) lines.push(`clientId: ${ctx.clientId}`);
    return lines.join('\n');
}
