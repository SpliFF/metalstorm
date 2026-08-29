/**
 * moment-hud.ts — "it is generally unclear what is happening in the battle"
 * (DESIGN-DRILLDOWN.md §2/§4/§5; battle-clarity U3, awareness)
 *
 * The user report, from a live `crossing_standoff`: first contact, two enemy
 * tanks nearly dead and a whole reinforcement wave all happened and NOTHING on
 * screen said so. Every one of those was already on the wire.
 *
 *     something happens  →  a notice arrives, and DECAYS
 *                        →  click it   →  what / who / where / when
 *                        →  "Go there" →  the camera travels (U0's one path)
 *                        →  off screen →  a minimap ping AND an edge pointer
 *                        →  all of it  →  the Events tab, behind ONE access point
 *
 * ── What this deliberately is NOT ──
 *
 * It is not an event log. An accumulating list beside the viewport is a
 * resident panel and a resident panel is the spreadsheet the directive
 * rejects — so the notices decay, at most `MAX_NOTICES` share the screen, and
 * the full history lives at rung 4 where the player goes to READ it. The lane
 * itself is U1's toast mechanism, lifted into `notice-lane.ts` and shared, so
 * this adds a source and not a second way of interrupting.
 *
 * ── Where the data comes from ──
 *
 * The worker (`core/battle-events.ts`) — because combat reaches the client only
 * there, and because two outcome families exist and hooking one covers about
 * half the arsenal. It posts DATA; the wording is `battle-moment-phrasing.ts`
 * and the naming is the same `resolveSelectionSubjects` the focus HUD uses, so
 * a notice calls a force what its chip calls it.
 *
 * ── Two widgets in one file ──
 *
 * `moment-hud` is the decaying rung-1 layer. `event-log` is the rung-4 Events
 * tab, mounted into the global surface by the manifest. They share this file
 * because they render the SAME moments through the same phrasing — splitting
 * them would be splitting one vocabulary across two files, which is the defect
 * U2 caught on screen.
 */

import { uiStore } from './ui-store.js';
import { nearestPlace } from './focus-hud.js';
import { resolveSelectionSubjects, type FocusRef } from './focus-model.js';
import { createGoThereButton, travelTo } from './camera-travel.js';
import { globalSurface } from './global-surface.js';
import {
    detailRow, detailReference,
    type DrilldownAction, type DrilldownStat, type DrilldownSummary,
} from './drilldown.js';
import { createNoticeLane, type NoticeLane } from './notice-lane.js';
import {
    frameClock, momentBriefing, momentCountLabel, momentHeadline, momentState,
    momentTone, type MomentContext,
} from './battle-moment-phrasing.js';
import type { BattleMoment, BattleMomentMarker } from '../../core/battle-events.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** How near a named place has to be before the moment is said to be AT it
 *  rather than merely near it. One engagement radius. */
export const PLACE_EXACT_ELMOS = 700;

/** How many rows the Events tab shows. It is a session record, not an audit
 *  trail; a player scrolling a thousand rows is reading a spreadsheet. */
export const EVENT_LOG_ROWS = 40;

// ───────────────────────── shared derivation ────────────────────────────

/**
 * Everything the wording needs, resolved from the client's own indexes.
 *
 * `subject` goes through `resolveSelectionSubjects` — the SAME rule the focus
 * HUD applies to a selection — so a squad under fire is called what it is
 * called when the player clicks on it. Anything ungrouped falls through to the
 * class-based wording rather than a made-up name.
 */
export function contextFor(m: BattleMoment): MomentContext {
    const near = nearestPlace({ x: m.x, z: m.z });
    const place = near
        ? {
            name: near.name,
            approximate: Math.hypot(near.x - m.x, near.z - m.z) > PLACE_EXACT_ELMOS,
        }
        : null;

    let subject: string | null = null;
    // Only OUR moments have unit ids we can name; an enemy force has no org
    // chart we are allowed to see.
    if (m.unitIds.length > 0 && m.kind !== 'kills'
        && m.kind !== 'enemy-crippled' && m.kind !== 'enemy-reinforcements') {
        const named = resolveSelectionSubjects(m.unitIds, uiStore.getOrgGroups())
            .find((s) => s.kind === 'squad');
        if (named) subject = named.label;
    }
    return { subject, place };
}

/** The ref a moment is addressed by — a place on the map, which is what makes
 *  it travellable everywhere it is rendered (U0 §5). */
export function momentRefFor(m: BattleMoment, ctx: MomentContext): FocusRef {
    return {
        kind: 'area',
        id: `moment:${m.id}`,
        label: momentHeadline(m, ctx),
        position: { x: m.x, z: m.z },
        unitIds: m.unitIds,
        data: { momentKind: m.kind, frame: m.frame, offScreen: m.offScreen === true },
    };
}

function summaryFor(m: BattleMoment, ctx: MomentContext): DrilldownSummary {
    const stats: DrilldownStat[] = [];
    const label = momentCountLabel(m, ctx);
    if (label && m.count > 0) stats.push({ label, value: String(m.count) });
    return { title: momentHeadline(m, ctx), state: momentState(m.kind), stats };
}

function renderDetail(host: HTMLElement, m: BattleMoment, ctx: MomentContext): void {
    const prose = document.createElement('p');
    prose.className = 'nui-dd__prose';
    prose.textContent = momentBriefing(m, ctx);
    host.append(prose);

    host.append(detailReference('Where', { x: m.x, z: m.z }, {
        note: ctx.place
            ? (ctx.place.approximate ? `near ${ctx.place.name}` : ctx.place.name)
            : `${Math.round(m.x)}, ${Math.round(m.z)}`,
    }));
    host.append(detailRow('When', frameClock(m.frame)));
    if (ctx.subject) host.append(detailRow('Who', ctx.subject));
    else if (m.className) host.append(detailRow('Who', m.className));
}

function actionsFor(): DrilldownAction[] {
    return [{
        id: 'open-log',
        label: 'Everything that happened',
        hint: 'Open the battle log behind the access point',
        run: () => globalSurface.open('events'),
    }];
}

// ─────────────────────────── the notice layer ───────────────────────────

const momentHud: Widget = {
    id: 'moment-hud',
    init(ctx: WidgetContext): void { mountNotices(ctx); },
    dispose(): void { teardownNotices?.(); teardownNotices = null; },
};

let teardownNotices: (() => void) | null = null;

function mountNotices(ctx: WidgetContext): void {
    teardownNotices?.();

    const root = document.createElement('div');
    root.className = 'nui-moments';
    ctx.mount.append(root);

    // The edge pointers live over the whole viewport, not inside a dock — that
    // is what an edge pointer IS. Parented to #ui-root (which is pointer-events
    // none by default; each pointer re-enables its own).
    const layer = document.createElement('div');
    layer.className = 'nui-edge-layer';
    layer.hidden = true;
    (document.getElementById('ui-root') ?? document.body).append(layer);

    const lane: NoticeLane = createNoticeLane(root);
    /** Moments we have already announced, so a store notification for a later
     *  moment does not re-announce the earlier ones. */
    let announced = 0;
    const pointers = new Map<number, HTMLButtonElement>();
    /** Live moments by id, so an edge pointer can label and travel to one that
     *  is no longer the newest. */
    const byId = new Map<number, BattleMoment>();

    const announce = (): void => {
        const all = uiStore.getBattleMoments();
        for (const m of all) {
            byId.set(m.id, m);
            if (m.id <= announced) continue;
            announced = m.id;
            const mctx = contextFor(m);
            if (!momentHeadline(m, mctx)) continue;   // no wording ⇒ no notice
            lane.push({
                key: `moment:${m.id}`,
                tone: momentTone(m.kind),
                drilldown: {
                    ref: momentRefFor(m, mctx),
                    summary: () => summaryFor(m, mctx),
                    detail: (host) => renderDetail(host, m, mctx),
                    actions: actionsFor,
                },
            });
        }
    };

    const applyMarkers = (): void => {
        const markers = uiStore.getBattleMarkers();
        const wanted = new Set<number>();
        for (const mk of markers) {
            const m = byId.get(mk.id);
            // On screen ⇒ no pointer at all. The player is already looking at
            // it, and an arrow to something in view is noise.
            if (!m || mk.onScreen) continue;
            wanted.add(mk.id);
            let el = pointers.get(mk.id);
            if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'nui-edge';
                el.dataset.momentId = String(mk.id);
                el.textContent = '◆';
                el.title = momentHeadline(m, contextFor(m));
                // The same one travel path every other affordance rides
                // (U0 §5) — ground-anchored, keeps the player's zoom.
                el.addEventListener('click', () => { travelTo({ x: m.x, z: m.z }); });
                layer.append(el);
                pointers.set(mk.id, el);
            }
            place(el, mk);
        }
        for (const [id, el] of [...pointers]) {
            if (!wanted.has(id)) { el.remove(); pointers.delete(id); }
        }
        layer.hidden = pointers.size === 0;
    };

    const unsubEvents = uiStore.subscribe(['gameEvents'], announce);
    const unsubMarkers = uiStore.subscribe(['battleMarkers'], applyMarkers);
    announce();
    applyMarkers();

    teardownNotices = () => {
        unsubEvents();
        unsubMarkers();
        lane.dispose();
        layer.remove();
        root.remove();
    };
}

/**
 * Put a pointer on the edge of the viewport in the direction of its moment.
 *
 * The worker hands us a normalised screen position that may be far outside
 * 0..1 (or pinned to a side when the fight is behind the camera). Clamping to a
 * margin turns that into a point ON the edge, which is what a player reads as
 * "over there" rather than "somewhere".
 */
function place(el: HTMLElement, mk: BattleMomentMarker): void {
    const margin = 3;                            // % inset, so the glyph is whole
    const x = Math.min(100 - margin, Math.max(margin, mk.sx * 100));
    const y = Math.min(100 - margin, Math.max(margin, mk.sy * 100));
    el.style.left = `${x}%`;
    el.style.top = `${y}%`;
    // Point the glyph outward, so the marker reads as a direction and not as a
    // thing sitting at the edge of the screen.
    const angle = Math.atan2(mk.sy - 0.5, mk.sx - 0.5) * 180 / Math.PI;
    el.style.setProperty('--nui-edge-angle', `${angle}deg`);
}

// ───────────────────── rung 4: the Events tab ───────────────────────────

/**
 * The full history, behind the one access point.
 *
 * This is where an accumulating list is CORRECT: the player asked for it, it is
 * modal, and it is the only rung with no size budget (§2). It renders from the
 * same `BattleMoment` records the notices did — never from parsing anything's
 * prose — so a line here and the notice it came from cannot disagree.
 */
const eventLog: Widget = {
    id: 'event-log',
    init(ctx: WidgetContext): void { mountLog(ctx); },
    dispose(): void { teardownLog?.(); teardownLog = null; },
};

let teardownLog: (() => void) | null = null;

function mountLog(ctx: WidgetContext): void {
    teardownLog?.();

    const root = document.createElement('div');
    root.className = 'nui-log';
    ctx.mount.append(root);

    const render = (): void => {
        root.replaceChildren();
        const all = uiStore.getBattleMoments();
        if (all.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'nui-log__empty';
            empty.textContent = 'Nothing has happened yet.';
            root.append(empty);
            return;
        }
        // Newest first: what a player opening this after a fight is looking for
        // is the last thing that happened, not the first.
        for (const m of [...all].slice(-EVENT_LOG_ROWS).reverse()) {
            const mctx = contextFor(m);
            const headline = momentHeadline(m, mctx);
            if (!headline) continue;
            const row = document.createElement('div');
            row.className = `nui-log__row nui-log__row--${momentTone(m.kind)}`;
            row.dataset.momentId = String(m.id);

            const when = document.createElement('span');
            when.className = 'nui-log__when';
            when.textContent = frameClock(m.frame);

            const text = document.createElement('span');
            text.className = 'nui-log__text';
            text.textContent = headline;

            row.append(when, text, createGoThereButton({ x: m.x, z: m.z }));
            root.append(row);
        }
    };

    const unsubscribe = uiStore.subscribe(['gameEvents'], render);
    render();
    teardownLog = () => { unsubscribe(); root.remove(); };
}

export { eventLog };
export default momentHud;
