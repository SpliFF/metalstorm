/**
 * ai-hud.ts — the co-commander AI's rung-1 chip (DESIGN-DRILLDOWN.md §2/§4)
 *
 *     an AI guides your team  →  one chip under the authority pill:
 *                                 Strategos · BALANCED · Tasks 3 · Spend ⬡42
 *                             →  click it  →  stance, ROE, what it is doing,
 *                                 its health, the squads it may not touch
 *                             →  actions: cycle stance · open the guidance panel
 *
 * ── Why a chip and not the panel ──
 *
 * `ai-command-panel` (Reports tab) is the CONTROL surface — stance, ROE,
 * region paint, locks, funding, intent, veto. It is rung 4 by the directive's
 * own list ("detailed reports"). What a player needs at a glance is one rung
 * lower: "is the AI OK, and what is it doing?" — which is exactly rung 1's
 * question for a squad. So the AI gets the same ladder a squad gets, and its
 * rung 3 hands off to the panel for anything that needs a form.
 *
 * ── Feature-detected, never assumed ──
 *
 * The chip is in the DOM only while something says an AI is guiding this
 * team: `guidance_<team>_stance` on the team wire (game_ai_guidance.lua
 * publishes it once the store exists) OR an AI seat on the roster. A team
 * with no AI sees nothing — a chip that reads "AI: none" is clutter that
 * reports an absence.
 *
 * ── The health params (ai-actuation lane, 2026-09-10) ──
 *
 * Lane 5 is adding an AI-health publication. This widget reads it by these
 * names and renders nothing for them until they appear:
 *
 *   teamRulesParam  guidance_<team>_health        0..1 ratio (AI health is a
 *                                                 RATIO, not hitpoints — see the
 *                                                 ai-health memory)
 *   teamRulesParam  guidance_<team>_health_note   one short string: why
 *   teamRulesParam  guidance_<team>_activity      one line: what it is doing now
 *
 * If lane 5 publishes under other names, change `HEALTH_KEYS` — one place.
 *
 * ── No per-frame anything ──
 *
 * Re-rendered on a `teamRulesParams` / `playerRoster` store notification and
 * on nothing else. There is no clock in this chip, so there is no timer.
 */

import { uiStore } from './ui-store.js';
import { focusModel, type FocusRef } from './focus-model.js';
import {
    createDrilldown, detailRow,
    type DrilldownAction, type DrilldownHandle, type DrilldownStat, type DrilldownSummary,
} from './drilldown.js';
import { globalSurface } from './global-surface.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** The team-param suffixes the health lane publishes. One place to rename. */
export const HEALTH_KEYS = {
    health: 'health',
    note: 'health_note',
    activity: 'activity',
} as const;

/** Stances in the order the cycle action walks them (game_ai_guidance.lua). */
export const STANCES = ['defensive', 'balanced', 'aggressive'] as const;

/** How many intent lines rung 2 shows before deferring to the panel. */
export const MAX_INTENT_ROWS = 5;

export interface AiFacts {
    present: boolean;
    name: string;
    stance: string | null;
    roe: string | null;
    profile: string | null;
    activity: string | null;
    /** 0..1, or null when not published. */
    health: number | null;
    healthNote: string | null;
    intents: Array<{ goal: string; group: string; spend: number }>;
    lockedGroups: number;
    delegatedObjectives: number;
    fundingRateCap: number | null;
}

const aiHud: Widget = {
    id: 'ai-hud',
    init(ctx: WidgetContext): void { mount(ctx); },
    dispose(): void { teardown?.(); teardown = null; },
};

let teardown: (() => void) | null = null;

function mount(ctx: WidgetContext): void {
    teardown?.();

    const root = document.createElement('div');
    root.className = 'nui-ai';
    root.hidden = true;
    ctx.mount.append(root);

    const teamId = ctx.identity?.teamId;
    let handle: DrilldownHandle | null = null;

    const render = (): void => {
        if (teamId === undefined) return;
        const facts = aiFactsFor(teamId);
        if (!facts.present) {
            handle?.dispose();
            handle = null;
            root.hidden = true;
            return;
        }
        if (!handle) {
            const ref = aiRefFor(teamId, facts.name);
            handle = createDrilldown({
                ref,
                travel: null,                       // the AI is nowhere on the map
                summary: () => summaryFor(aiFactsFor(teamId)),
                detail: (host) => renderDetail(host, aiFactsFor(teamId)),
                actions: () => actionsFor(ctx, teamId, aiFactsFor(teamId)),
            });
            root.append(handle.el);
        } else {
            handle.refresh();
        }
        root.hidden = false;
    };

    const unsubscribe = uiStore.subscribe(['teamRulesParams', 'playerRoster'], render);
    render();

    teardown = () => {
        unsubscribe();
        handle?.dispose();
        handle = null;
        root.remove();
    };
}

/** The ref the chip is addressed by — `kind: 'ai'`, id = team. */
export function aiRefFor(teamId: number, name: string): FocusRef {
    return { kind: 'ai', id: teamId, label: name, data: { teamId } };
}

// ───────────────────────────── the facts ────────────────────────────────

export function aiFactsFor(teamId: number): AiFacts {
    const get = (key: string) => uiStore.teamRulesParam(teamId, `guidance_${teamId}_${key}`);
    const str = (v: unknown): string | null =>
        v === undefined || v === null || v === '' ? null : String(v);
    const num = (v: unknown): number | null => {
        const n = Number(v);
        return v === undefined || v === null || v === '' || !Number.isFinite(n) ? null : n;
    };

    const aiSeats = uiStore.getPlayers().filter((p) => p.isAI && p.teamId === teamId && !p.isSpectator);
    const stance = str(get('stance'));
    const present = stance !== null || aiSeats.length > 0;

    const intents: AiFacts['intents'] = [];
    const intentCount = num(get('intent_count')) ?? 0;
    for (let i = 0; i < intentCount; i++) {
        intents.push({
            goal: str(get(`intent_${i}_goal`)) ?? '?',
            group: str(get(`intent_${i}_group`)) ?? '?',
            spend: num(get(`intent_${i}_spend`)) ?? 0,
        });
    }

    const listLen = (v: unknown) => str(v) ? String(v).split(',').filter(Boolean).length : 0;
    const seat = aiSeats[0];
    const profile = seat
        ? str(uiStore.teamRulesParam(teamId, `ai_profile_${seat.playerId}`))
            ?? str(uiStore.teamRulesParam(teamId, 'ai_profile'))
        : str(uiStore.teamRulesParam(teamId, 'ai_profile'));
    const rateCap = num(get('funding_rateCap'));

    return {
        present,
        name: seat?.name || 'AI',
        stance,
        roe: str(get('roe')),
        profile,
        activity: str(get(HEALTH_KEYS.activity)),
        health: clamp01(num(get(HEALTH_KEYS.health))),
        healthNote: str(get(HEALTH_KEYS.note)),
        intents,
        lockedGroups: listLen(get('lock_keys')),
        delegatedObjectives: listLen(get('delegated_keys')),
        // The gadget publishes -1 for "no cap".
        fundingRateCap: rateCap !== null && rateCap >= 0 ? rateCap : null,
    };
}

function clamp01(n: number | null): number | null {
    return n === null ? null : Math.max(0, Math.min(1, n));
}

// ────────────────────────────── rung 1 ──────────────────────────────────

/** A name, its stance as the state word, and at most three numbers. */
export function summaryFor(facts: AiFacts): DrilldownSummary {
    const stats: DrilldownStat[] = [];
    if (facts.health !== null) {
        const pct = Math.round(facts.health * 100);
        stats.push({
            label: 'Health', value: `${pct}%`,
            tone: facts.health >= 0.7 ? 'good' : facts.health <= 0.3 ? 'bad' : undefined,
        });
    }
    stats.push({ label: 'Tasks', value: String(facts.intents.length) });
    const spend = facts.intents.reduce((s, i) => s + i.spend, 0);
    if (spend > 0) stats.push({ label: 'Spend', value: `⬡${Math.round(spend)}`, tone: 'gold' });

    return {
        title: facts.name,
        state: facts.stance ?? 'guiding',
        stats,
    };
}

// ────────────────────────────── rung 2 ──────────────────────────────────

export function renderDetail(host: HTMLElement, facts: AiFacts): void {
    host.append(detailRow('Stance', facts.stance ?? 'not published yet'));
    host.append(detailRow('ROE', facts.roe ?? 'not published yet'));
    if (facts.profile) host.append(detailRow('Profile', facts.profile));

    // Health first when it exists — rung 2 answers "is it OK" before "what is
    // it doing". Absent params render as absent rows, not as "unknown": the
    // lane that publishes them may not have landed.
    if (facts.health !== null) {
        const pct = Math.round(facts.health * 100);
        host.append(detailRow('Health', facts.healthNote ? `${pct}% — ${facts.healthNote}` : `${pct}%`));
    }
    if (facts.activity) host.append(detailRow('Doing', facts.activity));

    if (facts.intents.length === 0) {
        host.append(detailRow('Tasks', 'none paid for yet'));
    } else {
        for (const intent of facts.intents.slice(0, MAX_INTENT_ROWS)) {
            host.append(detailRow(`${intent.goal} → ${intent.group}`, `⬡${Math.round(intent.spend)}`));
        }
        const more = facts.intents.length - MAX_INTENT_ROWS;
        if (more > 0) host.append(detailRow('…', `${more} more in the guidance panel`));
    }

    if (facts.lockedGroups > 0) {
        host.append(detailRow('Reserved', `${facts.lockedGroups} squad(s) it may not task`));
    }
    if (facts.delegatedObjectives > 0) {
        host.append(detailRow('Delegated', `${facts.delegatedObjectives} objective(s) handed to it`));
    }
    if (facts.fundingRateCap !== null) {
        host.append(detailRow('Funding', `capped at ⬡${facts.fundingRateCap}/min`));
    }
}

// ────────────────────────────── rung 3 ──────────────────────────────────

export function actionsFor(ctx: WidgetContext, teamId: number, facts: AiFacts): DrilldownAction[] {
    const idx = facts.stance ? STANCES.indexOf(facts.stance as typeof STANCES[number]) : -1;
    const next = STANCES[(idx + 1) % STANCES.length];
    const hasWire = typeof ctx.sendCommand === 'function';
    return [
        {
            id: 'stance',
            label: `Stance: ${next}`,
            hint: hasWire
                ? `Set the AI's stance to ${next} (now ${facts.stance ?? 'unknown'})`
                : 'Not available — no command channel',
            disabled: !hasWire,
            run: () => { ctx.sendCommand?.('guidance.stance', { value: next }); },
        },
        {
            id: 'guidance',
            label: 'Guidance…',
            hint: 'Region paint, asset locks, funding and vetoes live in the Reports tab',
            disabled: !globalSurface.mounted,
            run: () => {
                focusModel.collapse();
                globalSurface.open('reports');
            },
        },
    ];
}

// Keep the unused-import checker honest: `teamId` is what the ref is keyed on.
void aiRefFor;

export default aiHud;
