/**
 * objective-phrasing.ts — the sentences the wire does not carry
 * (DESIGN-DRILLDOWN.md §4; U1, interaction story 2)
 *
 * The player's report was that objectives were unclear and there was no way to
 * learn more about one. The objectives panel they were looking at rendered the
 * word `control` and a bare progress bar. `control` is a TYPE TAG — it tells a
 * player nothing about what to do, where, by when, or what happens if they do
 * not. There is no briefing text on the wire to fall back on
 * (`game_objectives.lua`'s PUBLISHED_FIELDS is structured fields only), so the
 * sentences have to be composed here.
 *
 * Composing them in ONE tested module rather than inside a renderer is the
 * whole point: a phrase is content, it gets read on every screen the objective
 * appears on (chip, context panel, toast, and — when U2 lands — a world
 * marker), and those must never word the same objective three different ways.
 *
 * ── The rules every phrase here obeys ──
 *
 *  1. **Never claim a fact the wire did not carry.** An unnamed place is "the
 *     ground", not an invented region; an approximate place is "near X"; an
 *     objective with no `expire` says "no time limit", not a made-up clock.
 *  2. **Say the verb first.** A rung-1 chip is read in a glance mid-battle, so
 *     it starts with what to DO ("Hold Raven Basin"), not with a category.
 *  3. **Progress is worded per type.** "62 %" is a number that needs its label
 *     read twice; "62 % held" does not, and the unit word differs by type —
 *     held / destroyed / of the way / intact.
 */

import {
    FRAMES_PER_SECOND, framesRemaining, isJoint, completedByUs,
    type ObjectiveRecord, type ObjectivePlace,
} from './objective-model.js';

/** m:ss for a frame count. Objectives run in minutes, so hours never appear. */
export function formatClock(frames: number): string {
    const total = Math.max(0, Math.round(frames / FRAMES_PER_SECOND));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/** How a place is spoken about, given how sure we are of its name. */
function placeWord(place: ObjectivePlace | null, fallback: string): string {
    if (!place || !place.name) return fallback;
    return place.approximate ? `near ${place.name}` : place.name;
}

/** The bare name, for phrasings where "near X" would not read ("Hold near X"). */
function placeName(place: ObjectivePlace | null): string | null {
    return place?.name ?? null;
}

/**
 * The chip title: a verb and a place, short enough to sit next to two numbers.
 *
 * `extract` reads its `stage` because securing a pickup and flying it out are
 * different jobs in different places, and the sim publishes which one is live.
 *
 * KNOWN GAP, measured live on `crossing_standoff` (U1's screenshot run) and
 * deliberately not fixed here: a title names an objective by TYPE and PLACE, so
 * two objectives of the same type on the same region get the SAME title. The
 * basin really does carry three at once — the scripted victory objective
 * (⬡300) plus two generated control objectives (⬡115 each) — and the stack
 * rendered "Hold Raven Basin" three times, distinguishable only by their reward
 * and progress numbers. Every row was truthful and none was a duplicate; they
 * were simply not tellable apart at a glance, which is the complaint this whole
 * step exists to answer.
 *
 * It is not fixed here because the fix is not a phrasing change: disambiguating
 * needs to know what ELSE is on the stack, and a function that takes one record
 * cannot. It belongs where the stack is assembled (`objective-hud.ts`'s
 * `render`), qualifying only the titles that actually collide — adding "the
 * war" or the scope to every title unconditionally would make the common case
 * worse to fix the rare one.
 */
export function shortName(o: ObjectiveRecord, place: ObjectivePlace | null): string {
    const named = placeName(place);
    const at = named ? (place!.approximate ? ` near ${named}` : ` ${named}`) : '';
    switch (o.type) {
        case 'control':
            return named ? `Hold ${named}` : 'Hold the ground';
        case 'kill':
            return named ? `Destroy the force${at}` : 'Destroy the target';
        case 'escort':
            return named ? `Escort to ${named}` : 'Escort the transport out';
        case 'protect':
            return named ? `Protect${at}` : 'Protect your people';
        case 'extract':
            return o.stage === 'evac'
                ? (named ? `Evacuate to ${named}` : 'Evacuate the cargo')
                : (named ? `Secure the pickup${at}` : 'Secure the pickup');
        case 'infra':
            return named ? `Keep${at} running` : 'Keep the works running';
        default:
            return named ? `${capitalise(o.type)}${at}` : capitalise(o.type);
    }
}

/** The unit word that makes `progress` mean something without a legend. */
export function progressWord(o: ObjectiveRecord): string {
    switch (o.type) {
        case 'control': return 'held';
        case 'kill':    return 'destroyed';
        case 'escort':  return 'of the way';
        case 'protect': return 'intact';
        case 'extract': return o.stage === 'evac' ? 'evacuated' : 'secured';
        case 'infra':   return 'running';
        default:        return 'done';
    }
}

/** "62 % held". Null when the sim has published no progress at all. */
export function progressPhrase(o: ObjectiveRecord): string | null {
    if (typeof o.progress !== 'number' || !Number.isFinite(o.progress)) return null;
    const pct = Math.round(Math.max(0, Math.min(1, o.progress)) * 100);
    return `${pct}% ${progressWord(o)}`;
}

/**
 * The one-line WHAT-TO-DO the rung-1 chip's context is built from: the verb,
 * the place, and how far along it is.
 *
 * Also used verbatim as the first row of the context panel, so a player who
 * drills in sees the sentence they clicked rather than a different one.
 */
export function taskLine(o: ObjectiveRecord, place: ObjectivePlace | null): string {
    const head = shortName(o, place);
    const progress = progressPhrase(o);
    return progress ? `${head} — ${progress}` : head;
}

/** The state WORD for a chip. One word, uppercased by CSS. */
export function stateWord(
    o: ObjectiveRecord,
    opts: { frame: number; teamId?: number },
): string {
    switch (o.state) {
        case 'complete': return completedByUs(o, opts.teamId) ? 'complete' : 'lost';
        case 'failed':   return 'failed';
        case 'expired':  return 'lapsed';
    }
    const remaining = framesRemaining(o, opts.frame);
    if (remaining !== null && remaining <= 0) return 'lapsed';
    if (o.stage === 'evac') return 'evacuating';
    if (o.stage === 'secure') return 'securing';
    return 'active';
}

/**
 * The briefing — the "further information" the player asked for by name.
 *
 * Two or three sentences: what the objective actually asks, then the facts that
 * change how you go about it (open race, joint, war-ending, delegated source).
 * Everything here is derived from a published field; nothing is invented.
 */
export function briefing(o: ObjectiveRecord, place: ObjectivePlace | null): string {
    const named = placeName(place);
    const where = placeWord(place, 'the marked ground');
    const sentences: string[] = [];

    switch (o.type) {
        case 'control':
            sentences.push(named
                ? `Take and hold ${named}. Control has to be unbroken — an enemy presence contests the region and resets the hold clock.`
                : 'Take and hold the region. Control has to be unbroken — an enemy presence contests it and resets the hold clock.');
            break;
        case 'kill':
            sentences.push(`Destroy the marked force ${where}.`);
            break;
        case 'escort':
            sentences.push(named
                ? `Keep the transport alive until it reaches ${named}. Losing the payload fails this outright — arriving empty is not arriving.`
                : 'Keep the transport alive until it reaches the exit. Losing the payload fails this outright.');
            break;
        case 'protect':
            sentences.push(`Keep the marked people alive ${where}. They cannot defend themselves, and a raid on them is how the other side denies you this.`);
            break;
        case 'extract':
            sentences.push(o.stage === 'evac'
                ? `The cargo is loaded. Fly it to ${where} — it only counts once it is off the field.`
                : `Secure the pickup ${where}, then get the cargo out.`);
            break;
        case 'infra':
            sentences.push(`Keep the works ${where} standing and running. Progress reads as the fraction still operating.`);
            break;
        default:
            sentences.push(`Complete the ${o.type} objective ${where}.`);
    }

    if (o.victory === 1) {
        sentences.push('This is the war\'s terminal objective: winning it ends the war.');
    }
    if (isJoint(o)) {
        sentences.push('This one is shared with a parley partner — it pays whoever finishes it first, not both of you.');
    } else if (o.team === undefined || o.team === -1) {
        sentences.push('Open race: either side can take it, and only the side that finishes it is paid.');
    }
    if (o.source === 'bounty') {
        sentences.push('A commander staked their own authority on this one.');
    } else if (o.source === 'systemic') {
        sentences.push('Raised by the world, not by the scenario — it appeared because of what is happening on the map.');
    }

    return sentences.join(' ');
}

/** What winning is worth and what losing costs. */
export function rewardPhrase(o: ObjectiveRecord): string {
    if (typeof o.reward !== 'number') return 'unpublished';
    return `+${Math.round(o.reward)} authority to whoever completes it`;
}

/** The consequence line — the half the old panel never showed at all. */
export function consequencePhrase(o: ObjectiveRecord, teamId?: number): string {
    if (o.victory === 1) {
        return 'Winning this ends the war. Losing the ground to the other side hands them the same win.';
    }
    if (o.state === 'complete') {
        return completedByUs(o, teamId) ? 'Paid.' : 'The reward went to whoever finished it.';
    }
    if (o.state === 'failed')  return 'Failed — the reward is gone.';
    if (o.state === 'expired') return 'Lapsed — the reward is gone.';
    if (o.type === 'protect')  return 'If the people you are covering are killed, the reward is lost and the other side is paid nothing for it either.';
    if (o.type === 'escort')   return 'If the transport dies the reward is lost, and so is whatever it was carrying.';
    if (o.expire !== undefined) return 'If it lapses you are paid nothing — there is no partial credit.';
    return 'No penalty for ignoring it beyond the reward you do not collect.';
}

/** The time row: a real countdown, or an honest statement that there is none. */
export function timePhrase(o: ObjectiveRecord, frame: number): string {
    if (o.expire === undefined) return 'No time limit';
    const remaining = framesRemaining(o, frame);
    if (remaining === null) return `Lapses at frame ${o.expire} (clock not yet known)`;
    if (remaining <= 0) return 'Lapsed';
    return `Lapses in ${formatClock(remaining)}`;
}

/** `strategic · scripted` — the provenance line, so a systemic objective and a
 *  staked bounty do not read as the same kind of thing. */
export function originPhrase(o: ObjectiveRecord): string {
    const bits = [o.scope ?? 'tactical'];
    if (o.source) bits.push(o.source);
    return bits.join(' · ');
}

/** The one line a toast shows. Short: it is read in passing, not studied. */
export function announcement(
    kind: 'appeared' | 'complete' | 'lost-race' | 'failed' | 'expired',
    o: ObjectiveRecord,
    place: ObjectivePlace | null,
): string {
    const name = shortName(o, place);
    const reward = typeof o.reward === 'number' ? `${Math.round(o.reward)}` : '—';
    switch (kind) {
        case 'appeared':  return `New objective — ${name}`;
        case 'complete':  return `Objective complete — ${name} (+${reward})`;
        case 'lost-race': return `Objective lost — ${name} went to the other side`;
        case 'failed':    return `Objective failed — ${name} (${reward} lost)`;
        case 'expired':   return `Objective lapsed — ${name} (${reward} lost)`;
    }
}

function capitalise(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
