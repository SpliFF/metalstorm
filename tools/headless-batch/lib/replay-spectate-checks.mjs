// What "a live client spectated a replay and changed nothing" means, as
// assertions over one arm's evidence — PLAN-replay §7.11 T2-a-1.
//
// Pure on purpose (two inputs: the harness's JSON verdict and the server's
// combined output), so test/replay-spectate.test.mjs can assert the rules
// without a server, and so a rule can be added here rather than inside the
// driver's control flow.
//
// The three claims task 4a shipped (§7.12) and this gate exists to keep true:
//
//   1. a live auth on a replay server resolves to `role=spectator team=-1`
//      whatever the account says;
//   2. its player number comes from the reserved range, so it cannot shift the
//      registration order the recorded auths cross-check against;
//   3. its sim-affecting verbs are refused — and the refusal must be OBSERVED,
//      not assumed. It was assumed from 2026-08-05 to 2026-08-14, during which
//      the gate was inert (server_main's peek verified the FlatBuffer with the
//      envelope byte still attached, so every verb read as NONE).
//
// The verify verdict carries the load for "changed nothing": the state hash
// folds units and the RNG, so a spectator that reached the sim diverges it.
// What a hash CANNOT see is a synced rules param (§7.12 mechanism 3 is about
// exactly that), which is why claim 3 is asserted from the log independently
// rather than being treated as implied by a PASS.

/** `replay::kSpectatorPlayerNumBase` (rts/Server/ReplayPlayer.h). Duplicated
 *  across a process boundary deliberately — the gate has to state the number it
 *  expects rather than read it back from the thing under test — and asserted
 *  loudly if the engine ever hands out something below it. */
export const SPECTATOR_PLAYER_NUM_BASE = 200;

const ADMIT_RE =
    /replay: admitting client (\d+) as spectator '([^']*)' \(playerNum (\d+), reserved range; not in the sim roster\)/;
const ATTACH_RE =
    /replay: spectator playerNum (\d+) attached to the playback controls \((\d+) watching, controller is (-?\d+)\)/;
const REFUSED_RE =
    /replay: client (\d+) sent sim-affecting verb (\d+) — refused/g;

/** Signals that a re-execution did not reproduce its recording. Any of them in
 *  the output fails the arm, whatever the verdict line says. */
const DIVERGENCE_SIGNALS = [
    'replay aborted:',
    'roster divergence',
    'player-number divergence',
    'replay verify: DIVERGENCE',
    'record(s) were fed LATE',
    'record(s) unfed',
];

/** Every ClientPayload tag the admission handshake needs; a refusal of one of
 *  these would mean nothing could spectate at all (T2-a-3). */
export function admissionTags(sentByPayload, refusedTags) {
    return refusedTags.filter((t) => (sentByPayload[String(t)] ?? 0) > 0);
}

/**
 * Assert one spectator arm.
 *
 * @param {object} a
 * @param {object} a.client        parsed `--json` output of run-wire-client.mjs
 * @param {string} a.serverOutput  the replay server's combined stdout+stderr
 * @param {object} a.verdict       readVerdict() over the same output
 * @param {number[]} a.expectRefusedTags ClientPayload tags the arm sent that
 *        the server MUST have refused (the harness reports the numbers off the
 *        generated schema, so nothing is hardcoded here)
 * @returns {{ok: boolean, problems: string[], facts: object}}
 */
export function checkSpectatorArm({ client, serverOutput, verdict, expectRefusedTags = [] }) {
    const problems = [];
    const facts = {};

    // ── the harness's own verdict ────────────────────────────────────────
    if (!client || typeof client !== 'object') {
        return { ok: false, problems: ['the wire client produced no JSON verdict'], facts };
    }
    for (const f of client.failures ?? []) problems.push(`wire client: ${f}`);
    for (const w of client.writeErrors ?? []) problems.push(`wire client write failed: ${w}`);

    // ── claim 1 + 2: the identity is pinned, from the reserved range ─────
    const auth = client.auth ?? {};
    facts.playerNum = auth.playerNum;
    facts.team = auth.team;
    facts.role = auth.role;
    if (!auth.ok) problems.push(`auth was refused (status ${auth.status}: ${auth.message || 'no message'})`);
    if (auth.role !== 'spectator') problems.push(`role is '${auth.role}', not 'spectator'`);
    if (auth.team !== -1) problems.push(`team is ${auth.team}, not -1`);
    if (!(auth.playerNum >= SPECTATOR_PLAYER_NUM_BASE)) {
        problems.push(`playerNum ${auth.playerNum} is below the reserved base `
            + `${SPECTATOR_PLAYER_NUM_BASE} — it can collide with a recorded one`);
    }

    // ── the server agrees, and says so about the SAME player number ──────
    const admit = serverOutput.match(ADMIT_RE);
    const attach = serverOutput.match(ATTACH_RE);
    if (!admit) {
        problems.push('the server never logged admitting a replay spectator — the arm is '
            + 'VACUOUS: the client did not get in before the re-execution ended '
            + '(raise the fixture length, or lower the harness start-up cost)');
    } else {
        facts.admittedPlayerNum = Number(admit[3]);
        facts.admittedUsername = admit[2];
        if (facts.admittedPlayerNum !== auth.playerNum) {
            problems.push(`the server admitted playerNum ${admit[3]} but the AuthResponse `
                + `carried ${auth.playerNum}`);
        }
    }
    if (!attach) problems.push('the spectator was never attached to the playback controls');
    else facts.watchers = Number(attach[2]);

    // ── claim 3: the refusal is OBSERVED ────────────────────────────────
    const refused = [...serverOutput.matchAll(REFUSED_RE)].map((m) => Number(m[2]));
    facts.refusedVerbs = refused;
    for (const tag of expectRefusedTags) {
        if (!refused.includes(tag)) {
            problems.push(`the server did not refuse ClientPayload ${tag} — a live client's `
                + 'sim-affecting verb reached the re-execution');
        }
    }

    // ── the re-execution still reproduced its recording ─────────────────
    facts.verdict = verdict?.verdict;
    if (verdict?.verdict !== 'pass') {
        problems.push(`the verify verdict is ${verdict?.verdict ?? 'missing'}`
            + (verdict?.line ? `: ${verdict.line}` : ''));
    } else {
        facts.checked = verdict.checked;
        facts.matched = verdict.matched;
        facts.fed = verdict.fed;
        if (verdict.checked < 2) {
            problems.push(`PASS over only ${verdict.checked} reference point(s) — not a gate`);
        }
    }
    for (const sig of DIVERGENCE_SIGNALS) {
        if (serverOutput.includes(sig)) problems.push(`the server reported '${sig}'`);
    }

    // ── ordering: the spectator must have been present DURING the run ────
    // A PASS logged before the spectator ever authenticated proves nothing
    // about the spectator, and both lines being present does not order them.
    if (admit && verdict?.line) {
        const iAdmit = serverOutput.indexOf(admit[0]);
        const iVerdict = serverOutput.indexOf(verdict.line);
        facts.admittedBeforeVerdict = iAdmit >= 0 && iAdmit < iVerdict;
        if (!facts.admittedBeforeVerdict) {
            problems.push('the spectator was admitted AFTER the verify verdict was logged — '
                + 'it was not attached during the re-execution');
        }
    }

    return { ok: problems.length === 0, problems, facts };
}

/**
 * Assert the matched control: the same recording, re-executed with nobody
 * watching. Its job is to make the spectator arm's PASS mean something — a
 * green arm whose control is also green in the ABSENCE of every spectator line
 * is the pair that says the spectator was the only difference.
 */
export function checkControlArm({ serverOutput, verdict }) {
    const problems = [];
    const facts = { verdict: verdict?.verdict };

    if (verdict?.verdict !== 'pass') {
        problems.push(`the control's verify verdict is ${verdict?.verdict ?? 'missing'}`
            + (verdict?.line ? `: ${verdict.line}` : ''));
    } else {
        facts.checked = verdict.checked;
        facts.matched = verdict.matched;
        facts.fed = verdict.fed;
    }
    if (ADMIT_RE.test(serverOutput)) {
        problems.push('the control admitted a spectator — the two arms differ by more than '
            + 'the spectator (a stale port, or a client pointed at the wrong server)');
    }
    if (serverOutput.match(REFUSED_RE)) {
        problems.push('the control refused a sim-affecting verb — something else is talking to it');
    }
    for (const sig of DIVERGENCE_SIGNALS) {
        if (serverOutput.includes(sig)) problems.push(`the control reported '${sig}'`);
    }

    return { ok: problems.length === 0, problems, facts };
}

/**
 * The pair itself: watching a replay must not change what the re-execution did.
 * Compared as a triple rather than "both passed", because both arms passing
 * with different `fed` counts would mean the spectator's presence changed how
 * much of the recording was consumed.
 */
export function compareArms(spectator, control) {
    const problems = [];
    for (const key of ['checked', 'matched', 'fed']) {
        if (spectator[key] !== control[key]) {
            problems.push(`${key}: ${spectator[key]} with a spectator, ${control[key]} without — `
                + 'watching a replay changed its re-execution');
        }
    }
    return { ok: problems.length === 0, problems };
}
