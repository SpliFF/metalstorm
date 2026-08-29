/**
 * objective-markers.ts — an objective, reduced to something you can DRAW
 * (DESIGN-DRILLDOWN.md §4 "floating chips vs docked panels"; U2, story 2)
 *
 * > If the player needs to know WHERE, it is an icon in the world.
 * > If they need to know WHAT, it is a surface at the edge.
 *
 * U1 gave objectives a name, a briefing and a "Go there" button — all of which
 * answer WHAT. The player's report also said they could not tell where an
 * objective *was*, and no amount of text at the edge of the screen fixes that:
 * the answer to "where" is a mark on the ground you find by LOOKING.
 *
 * This module is the one derivation both marker surfaces read — the Babylon
 * rings in the world (`objective-marker-renderer.ts`) and the minimap blips
 * (`minimap.ts`). One derivation on purpose: a ring in the world and a dot on
 * the minimap that disagree about which objectives exist is worse than either
 * alone, because the player uses the minimap to decide where to look.
 *
 * ── Why it lives in `core/` and runs in the worker ──
 *
 * The world scene is worker-resident (GW8) and `liveState.gameRulesParams`
 * already carries every `objective_*` and `region_*` key there — the same map
 * main's `uiStore` holds, fed by the same `rulesParamUpdate`. Deriving here
 * costs no new stream and no new main→worker message; the minimap (main) is
 * fed the finished list instead, which is a handful of numbers per objective.
 *
 * It reuses `objective-model.ts`'s parser rather than re-reading the wire
 * format, so the marker layer and the HUD can never disagree about what an
 * objective IS — only about how it is drawn.
 *
 * ── Pure ──
 *
 * No Babylon, no DOM, no globals. `deriveObjectiveMarkers` is a function of the
 * params map and the viewer's identity, which is what makes the "what is drawn"
 * half testable without a scene.
 */

import {
    parseObjectives, visibleTo, isResolved, framesRemaining, URGENT_FRAMES,
    type ObjectiveRecord,
} from '../ui/native-ui/objective-model.js';
import { shortName } from '../ui/native-ui/objective-phrasing.js';

/** One drawable objective. Everything a ring or a blip needs, and nothing a
 *  renderer would have to go looking for. */
export interface ObjectiveMarker {
    id: number;
    /** Centre, in elmos. */
    x: number;
    z: number;
    /**
     * Radius in elmos. `0` means the objective published a position but no
     * extent (a `kill` target is a moving unit, not an area) — renderers draw a
     * BEACON there rather than a ring, which is honest about the difference:
     * a ring claims an area, and we do not have one.
     */
    r: number;
    /** The chip's own title, so the world and the HUD name it identically. */
    label: string;
    /** Eligible team, or -1 for an open race. Drives the faction tint. */
    team: number;
    /** True when the viewer's own team is the eligible one. */
    mine: boolean;
    /** Winning this ends the war — the one marker that outranks the rest. */
    victory: boolean;
    /** 0..1, or 0 when the objective publishes none. */
    progress: number;
    /** Under two sim minutes to expiry. */
    urgent: boolean;
}

/**
 * Region statics, as `game_regions.lua` publishes them.
 *
 * Only used as the fallback centre for an objective whose region key resolves
 * but whose circle did not reach us — a scenario running an older gadget, or a
 * region the partition cannot place ("wilds"). The radius is deliberately NOT
 * guessed here: a ring drawn at an invented radius is a lie about an area, and
 * `r: 0` already has a truthful rendering.
 */
function regionCentre(
    params: ReadonlyMap<string, number | string>,
    key: string,
): { x: number; z: number } | null {
    const x = Number(params.get(`region_${key}_x`));
    const z = Number(params.get(`region_${key}_z`));
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    return { x, z };
}

/**
 * The nearest named place to a bare coordinate.
 *
 * `resolvePlace` on main does this through the named-entity index; the worker
 * has no index, but it has the same SOURCE — `region_<key>_name/_x/_z` and
 * `landmark_<key>_x/_z` are what `entity-index-producer.ts` builds that index
 * out of — so it reads them directly rather than asking main for an answer it
 * already holds the inputs for.
 *
 * This exists because of a mismatch measured on screen: the chip said "Protect
 * near Storm Sound" and the ring under it said "Protect your people". A world
 * marker and a summary chip that word one objective two ways is precisely what
 * `objective-phrasing.ts` was written in one place to prevent — and the marker
 * was the one that was wrong, because it handed the phrasing a nameless place.
 *
 * Linear over the region/landmark keys, run at most every 400 ms on a map with
 * a few dozen named places.
 */
function nearestNamedPlace(
    params: ReadonlyMap<string, number | string>,
    at: { x: number; z: number },
): string | null {
    let best: string | null = null;
    let bestD2 = Infinity;
    for (const [key, value] of params) {
        let name: string | null = null;
        let xKey = '';
        let zKey = '';
        const region = /^region_(.+)_name$/.exec(key);
        if (region) {
            name = String(value);
            xKey = `region_${region[1]}_x`;
            zKey = `region_${region[1]}_z`;
        } else {
            const landmark = /^landmark_(.+)_x$/.exec(key);
            if (!landmark) continue;
            const slug = landmark[1];
            name = String(params.get(`landmark_${slug}_name`) ?? slug);
            xKey = `landmark_${slug}_x`;
            zKey = `landmark_${slug}_z`;
        }
        const x = Number(params.get(xKey));
        const z = Number(params.get(zKey));
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const d2 = (x - at.x) ** 2 + (z - at.z) ** 2;
        if (d2 < bestD2) { bestD2 = d2; best = name; }
    }
    return best;
}

export interface MarkerContext {
    /** Our sim team, for the tint and the eligibility filter. */
    teamId?: number;
    /** Current sim frame, 0 when unknown — only feeds `urgent`. */
    frame?: number;
}

/**
 * Which objectives get a mark on the ground, and where.
 *
 * Three exclusions, each for a reason a player would agree with:
 *
 *  1. **Resolved objectives.** The sim retains their params for 30 s so the
 *     HUD can say "you lost that one"; a ring is a place to GO, and there is
 *     no longer anywhere to go. The chip keeps saying it, the world stops.
 *  2. **Objectives we are not eligible for.** Same `visibleTo` rule the chip
 *     stack uses — a marker the player cannot act on is clutter by definition.
 *  3. **Objectives with no position at all.** A `kill` on a unit we have never
 *     seen publishes no coordinate; there is nothing to draw and nothing to
 *     invent.
 */
export function deriveObjectiveMarkers(
    params: ReadonlyMap<string, number | string>,
    ctx: MarkerContext = {},
): ObjectiveMarker[] {
    const out: ObjectiveMarker[] = [];
    for (const o of parseObjectives(params)) {
        if (o.state !== undefined && o.state !== 'active') continue;
        if (isResolved(o)) continue;
        if (!visibleTo(o, ctx.teamId)) continue;

        const placed = placeOf(o, params);
        if (!placed) continue;

        const remaining = framesRemaining(o, ctx.frame ?? 0);
        out.push({
            id: o.id,
            x: placed.x,
            z: placed.z,
            r: placed.r,
            // The SAME title the chip shows, hedge and all. An earlier cut
            // suppressed the "near" on the reasoning that a marker sits ON the
            // place it names; on screen that produced "Protect your people"
            // under a chip reading "Protect near Storm Sound", which is two
            // names for one objective — a worse failure than a hedge.
            label: shortName(o, {
                name: placed.name,
                x: placed.x,
                z: placed.z,
                r: placed.r || undefined,
                approximate: placed.approximate,
            }),
            team: o.team ?? -1,
            mine: o.team !== undefined && o.team !== -1 && o.team === ctx.teamId,
            victory: o.victory === 1,
            progress: typeof o.progress === 'number' ? o.progress : 0,
            urgent: remaining !== null && remaining < URGENT_FRAMES,
        });
    }
    // Stable order so a renderer's fingerprint does not churn on map iteration
    // order, and so the minimap's instance buffer is comparable frame to frame.
    out.sort((a, b) => a.id - b.id);
    return collapseCoincident(out);
}

/**
 * Two objectives on the same circle are ONE PLACE.
 *
 * `crossing_standoff` genuinely carries three objectives on Raven Basin at once
 * (a scripted victory objective plus systemic control objectives the generator
 * raises on the same contested region), and drawing them all put three
 * identical rings and three identical labels in exactly the same spot — seen on
 * screen, and unreadable: z-fighting outlines and text painted over itself.
 *
 * The world layer answers WHERE, and the answer to "where are these three" is
 * one place. So a coincident group collapses to its most important member, by
 * the same precedence the chip stack ranks by (war-ending, then a deadline,
 * then work already committed). The others are not lost — they are enumerated
 * at rung 1, which is where a LIST belongs; U1's own field notes record that
 * telling same-titled objectives apart is `objective-hud`'s job, not a marker's.
 *
 * Coincidence is judged at the fingerprint's own 8-elmo quantum, so a group
 * does not flicker in and out as a protect objective's centroid drifts.
 */
function collapseCoincident(markers: readonly ObjectiveMarker[]): ObjectiveMarker[] {
    const best = new Map<string, ObjectiveMarker>();
    for (const m of markers) {
        const key = `${Math.round(m.x / 8)}:${Math.round(m.z / 8)}:${Math.round(m.r / 8)}`;
        const held = best.get(key);
        if (!held || rank(m) > rank(held)) best.set(key, m);
    }
    return [...best.values()].sort((a, b) => a.id - b.id);
}

/** Which of two objectives at one place gets the ring. Mirrors
 *  `rankObjectives`' top three rules; the reward tie-break is not repeated
 *  because a stable `id` order is a better tie-break for a mesh set. */
function rank(m: ObjectiveMarker): number {
    return (m.victory ? 4 : 0) + (m.urgent ? 2 : 0) + (m.progress > 0.02 ? 1 : 0);
}

/**
 * Where a marker goes and what it is called — the same two-source split
 * `resolvePlace` makes on main: the region key names the place exactly, a bare
 * coordinate gets the nearest named place and is `approximate`.
 */
function placeOf(
    o: ObjectiveRecord,
    params: ReadonlyMap<string, number | string>,
): { x: number; z: number; r: number; name: string | null; approximate: boolean } | null {
    const regionName = typeof o.region === 'string'
        ? (params.get(`region_${o.region}_name`) as string | undefined) ?? null
        : null;

    if (typeof o.x === 'number' && typeof o.z === 'number') {
        const at = { x: o.x, z: o.z };
        const name = regionName ?? nearestNamedPlace(params, at);
        return {
            ...at,
            r: typeof o.r === 'number' ? Math.max(0, o.r) : 0,
            name,
            approximate: regionName === null,
        };
    }
    if (typeof o.region === 'string') {
        const centre = regionCentre(params, o.region);
        if (centre) return { ...centre, r: 0, name: regionName, approximate: false };
    }
    return null;
}

/**
 * Cheap "did anything a renderer cares about change?" key.
 *
 * Rounded to 8 elmos so a protect objective whose targets shuffle a metre does
 * not rebuild the mesh set — its circle is re-derived from live unit positions
 * on every objectives evaluation tick, so the raw numbers are never still.
 *
 * A plain round, deliberately: jitter across a bucket edge does rebuild, and
 * carrying hysteresis state to close that would cost more than the rebuild. It
 * is bounded on both sides — `gpRefreshObjectiveMarkers` recomputes at most
 * every 400 ms, and the renderer caches materials and label textures, so a
 * rebuild is a handful of torus allocations and nothing else.
 */
export function markersFingerprint(markers: readonly ObjectiveMarker[]): string {
    let fp = '';
    for (const m of markers) {
        fp += `${m.id}:${Math.round(m.x / 8)}:${Math.round(m.z / 8)}:${Math.round(m.r / 8)}`
            + `:${m.team}:${m.mine ? 1 : 0}:${m.victory ? 1 : 0}:${m.urgent ? 1 : 0}`
            + `:${Math.round(m.progress * 20)}:${m.label}|`;
    }
    return fp;
}
