/**
 * battle-moment-phrasing.ts — English for what just happened
 * (battle-clarity U3; the battle-side sibling of `objective-phrasing.ts`)
 *
 * ONE place composes the words for a battle moment, for the reason U2 found on
 * screen: when a second surface words the same event for itself, the player
 * ends up looking at a ring saying "Protect your people" underneath a chip
 * saying "Protect near Storm Sound". The notice, the rung-2 panel and the
 * rung-4 history all read from here.
 *
 * ── Reused from the war digest, deliberately ──
 *
 * `client/src/lobby/war-digest.ts` already words strategic events for the
 * while-you-were-away digest, and `game_warlog.lua` already decided what the
 * sim will say about itself. Nothing here re-implements those — the KINDS do
 * not overlap (the warlog is regions, objectives and pacts over a week-long
 * war; this is one firefight) — but three of its rules are carried over intact,
 * because they are the parts that were learned rather than chosen:
 *
 *   1. **Say WHOSE.** A team NUMBER means nothing to anybody outside the sim.
 *      Ours is "your", theirs is "enemy", and a force with a name gets its
 *      name — "3rd Tanks", never "4 units", which is the spreadsheet reading.
 *   2. **Say WHERE.** The digest's news is "You took Ridge Crossing", not "a
 *      region changed hands". A fight with no place is a fight the player
 *      cannot go to.
 *   3. **An unworded kind degrades to nothing, never to `undefined`.** A build
 *      that meets a moment it has no wording for shows fewer notices, not a
 *      notice reading "undefined".
 *
 * Pure: no DOM, no store, no clock. Everything it needs is an argument.
 */

import { classVocabulary } from './class-vocabulary.js';
import type { BattleMoment, BattleMomentKind } from '../../core/battle-events.js';

/** What the caller resolved about a moment before asking for words. */
export interface MomentContext {
    /**
     * The named force this is about ("3rd Tanks"), when the org-group roster
     * could name one. Null ⇒ fall back to a class ("your tanks") and then to a
     * bare count, in that order.
     */
    subject?: string | null;
    /** Nearest named place ("Raven Basin"), and whether it is only NEAR it. */
    place?: { name: string; approximate: boolean } | null;
}

/** The one state word for rung 1. Uppercased by CSS, not here. */
export function momentState(kind: BattleMomentKind): string {
    switch (kind) {
        case 'first-contact':        return 'contact';
        case 'under-fire':           return 'under fire';
        case 'losses':               return 'lost';
        case 'kills':                return 'destroyed';
        case 'enemy-crippled':       return 'crippled';
        case 'reinforcements':       return 'arrived';
        case 'enemy-reinforcements': return 'detected';
        default:                     return '';
    }
}

/** How urgent this reads. Drives the notice's colour and nothing else. */
export function momentTone(kind: BattleMomentKind): 'good' | 'bad' | 'accent' {
    switch (kind) {
        case 'kills':
        case 'enemy-crippled':
        case 'reinforcements':
            return 'good';
        case 'losses':
        case 'under-fire':
            return 'bad';
        default:
            return 'accent';
    }
}

/** "near Raven Basin" / "at Raven Basin" / '' when nothing is named. */
export function placePhrase(ctx: MomentContext): string {
    const place = ctx.place;
    if (!place?.name) return '';
    return place.approximate ? `near ${place.name}` : `at ${place.name}`;
}

/**
 * The singular of an `ms_class` key, for the one place a class word has to
 * qualify a noun ("soldier squads" and not "soldiers squads").
 *
 * The authored vocabulary is the source: `class-vocabulary.json` carries a
 * `display` (singular, "Soldier") beside the `plural` the class key already
 * is. Falling back to stripping an "s" is deliberate and last-resort — the
 * naive rule is right for every shipped class key and wrong for a future one,
 * and the vocabulary is where a game fixes that rather than here.
 */
export function classSingular(className: string): string {
    const entry = classVocabulary.current.data.classes[className];
    if (entry?.display) return entry.display.toLowerCase();
    return className.endsWith('s') && !className.endsWith('ss')
        ? className.slice(0, -1)
        : className;
}

/**
 * "3 soldier squads" / "2 enemy tanks" / "3 units" — a count and what it counts.
 *
 * The side word is a QUALIFIER the caller supplies, and it goes after the
 * count, not in front of the whole phrase: "2 enemy tanks destroyed" reads,
 * "Enemy 2 tanks destroyed" does not. A caller whose headline already says
 * whose ("Enemy wave at Raven Basin") passes none, so the line does not go on
 * to say "4 enemy soldier squads".
 */
function countNoun(m: BattleMoment, qualifier = ''): string {
    const q = qualifier ? `${qualifier} ` : '';
    const plural = m.count !== 1;
    if (m.className) {
        return m.squads
            ? `${m.count} ${q}${classSingular(m.className)} squad${plural ? 's' : ''}`
            : `${m.count} ${q}${plural ? m.className : classSingular(m.className)}`;
    }
    return `${m.count} ${q}${m.squads ? 'squad' : 'unit'}${plural ? 's' : ''}`;
}

/** The noun for a count of our things: the group's name if it has one, else
 *  the class, else an honest count. */
function ourNoun(m: BattleMoment, ctx: MomentContext): string {
    return ctx.subject ?? countNoun(m);
}

/** The same, for the other side. Never named — we do not know their org chart. */
function theirNoun(m: BattleMoment): string {
    return countNoun(m, 'enemy');
}

/**
 * The one line. Sentence case, no trailing stop — it is a headline on a chip,
 * not prose.
 *
 * Returns '' for a kind this build has no wording for (rule 3 above).
 */
export function momentHeadline(m: BattleMoment, ctx: MomentContext = {}): string {
    const where = placePhrase(ctx);
    const at = where ? ` ${where}` : '';
    switch (m.kind) {
        case 'first-contact':
            return where ? `First contact ${where}` : 'First contact';
        case 'under-fire':
            return `${cap(ourNoun(m, ctx))} under fire${at}`;
        case 'losses':
            return `${cap(ourNoun(m, ctx))} lost${at}`;
        case 'kills':
            return `${cap(theirNoun(m))} destroyed${at}`;
        case 'enemy-crippled':
            return `${cap(theirNoun(m))} nearly destroyed${at}`;
        case 'reinforcements':
            return `Reinforcements${at}: ${ourNoun(m, ctx)}`;
        case 'enemy-reinforcements':
            // "Enemy wave" already says whose, so the noun must not repeat it.
            return `Enemy wave${at}: ${countNoun(m)}`;
        default:
            return '';
    }
}

/**
 * The sentence rung 2 opens with — the same news, said in full rather than in
 * headline form, plus the one thing rung 1 has no room for: whether the player
 * was looking at it.
 */
export function momentBriefing(m: BattleMoment, ctx: MomentContext = {}): string {
    const seen = m.offScreen
        ? 'This happened off screen.'
        : 'This happened in view.';
    // A named force is always spoken of in the plural ("3rd Tanks are"), so
    // agreement follows the COUNT only when the noun is a count. Caught on
    // screen: "1 tank squad were destroyed".
    const many = m.count !== 1 || !!ctx.subject;
    const is = many ? 'are' : 'is';
    const was = many ? 'were' : 'was';
    switch (m.kind) {
        case 'first-contact':
            return `The battle has started. ${seen}`;
        case 'under-fire':
            return `${cap(ourNoun(m, ctx))} ${is} taking fire. ${seen}`;
        case 'losses':
            return `${cap(ourNoun(m, ctx))} ${was} destroyed. ${seen}`;
        case 'kills':
            return `${cap(theirNoun(m))} ${was} destroyed. ${seen}`;
        case 'enemy-crippled':
            return `${cap(theirNoun(m))} ${is} nearly destroyed and can be finished. ${seen}`;
        case 'reinforcements':
            return `${cap(ourNoun(m, ctx))} arrived. ${seen}`;
        case 'enemy-reinforcements':
            return `${cap(theirNoun(m))} came into view. ${seen}`;
        default:
            return seen;
    }
}

/**
 * The rung-1 stat: one number, labelled with the noun it counts — or NOTHING.
 *
 * Empty whenever the headline already carries the count, which is every case
 * except a moment whose force has a name ("3rd Tanks under fire"). Seen live:
 * `4 soldier squads · DETECTED · Squads 4` says four twice, and the rung-1
 * budget is about what a player reads at a glance, not about how many fields
 * are permitted.
 */
export function momentCountLabel(m: BattleMoment, ctx: MomentContext = {}): string {
    if (m.kind === 'first-contact') return '';
    if (!ctx.subject) return '';
    return m.squads ? 'Squads' : 'Units';
}

/** `1234` → `"0:41"`. Sim frames at 30 Hz, the clock every other surface uses. */
export function frameClock(frame: number): string {
    const total = Math.max(0, Math.floor(frame / 30));
    const mins = Math.floor(total / 60);
    return `${mins}:${String(total % 60).padStart(2, '0')}`;
}

function cap(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
