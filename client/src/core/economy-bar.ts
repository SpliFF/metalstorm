/**
 * EconomyBar — top-of-screen metal+energy panel.
 *
 * Native HTML/CSS, styled to match the chili-style BuildMenu (dark
 * gradient frame, slotted bevels). Built directly off the server's
 * ResourceUpdate stream rather than through the chili widget pipeline,
 * so it works even when LuaUI isn't fully booted (chili rendering is
 * still being stabilised — see PLAN-chili-menu-visibility.md).
 *
 * Layout (per-resource):
 *   ┌─ M ─ 1.2k / 4.0k ─────────────────────────── +12.3 ─ -8.7 ─┐
 *   │ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
 *   └─────────────────────────────────────────────────────────────┘
 *
 *   left:   resource icon ("M" or "E"), current/max numbers
 *   right:  income (+green), expense (-red)
 *   bar:    fill = current/max; segmented stripe at the share
 *           threshold (storage limit before excess kicks in)
 *
 * The widget intentionally only shows local-team resources. Spectator
 * mode and ally tabs would belong in a follow-up — for now the panel
 * shows nothing while the local team is unset (e.g. spectating).
 */
import type { ResourceUpdateInfo } from './connection.js';

export interface EconomyBarOptions {
    /** Local team id; updates for other teams are ignored. */
    myTeam: number;
}

export class EconomyBar {
    private root: HTMLDivElement;
    private myTeam: number;

    private metalRow: ResourceRow;
    private energyRow: ResourceRow;

    /** Last update we displayed, kept for the tooltip. */
    private last: ResourceUpdateInfo | null = null;

    constructor(opts: EconomyBarOptions) {
        this.myTeam = opts.myTeam;

        this.root = document.createElement('div');
        this.root.id = 'economy-bar';
        this.root.style.display = 'none';

        this.metalRow = new ResourceRow('M', 'metal');
        this.energyRow = new ResourceRow('E', 'energy');
        this.root.appendChild(this.metalRow.el);
        this.root.appendChild(this.energyRow.el);

        this.injectStyle();
        document.body.appendChild(this.root);
    }

    /** Push a fresh ResourceUpdate. No-op for non-local teams. */
    update(info: ResourceUpdateInfo): void {
        if (info.team !== this.myTeam) return;
        this.last = info;

        this.metalRow.update(
            info.metal, info.maxMetal,
            info.metalIncome, info.metalExpense || info.metalPull,
        );
        this.energyRow.update(
            info.energy, info.maxEnergy,
            info.energyIncome, info.energyExpense || info.energyPull,
        );

        this.root.style.display = 'block';
        this.root.title = formatTooltip(info);
    }

    /** Change which team's resources are displayed. */
    setTeam(team: number): void {
        if (team === this.myTeam) return;
        this.myTeam = team;
        this.last = null;
        this.root.style.display = 'none';
    }

    dispose(): void {
        this.root.remove();
        document.getElementById('economy-bar-style')?.remove();
    }

    private injectStyle(): void {
        if (document.getElementById('economy-bar-style')) return;
        const css = `
#economy-bar {
    position: fixed;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 20;
    background: linear-gradient(180deg, #1a1d22 0%, #0f1114 100%);
    border: 1px solid #2a2f38;
    border-top-color: #3a4150;
    border-radius: 4px;
    padding: 4px 8px;
    box-shadow: 0 0 0 1px #000, 0 4px 14px rgba(0, 0, 0, 0.6);
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 380px;
    font: 12px/1.2 system-ui, sans-serif;
    color: #e0e0e0;
    user-select: none;
}
.eco-row {
    display: grid;
    grid-template-columns: 18px 1fr auto auto;
    align-items: center;
    column-gap: 8px;
    height: 22px;
    padding: 0 4px;
    background: #0a0c10;
    border: 1px solid #000;
    border-top-color: #1c2028;
    border-radius: 2px;
    position: relative;
    overflow: hidden;
}
.eco-row-metal .eco-icon { color: #d8d4b0; }
.eco-row-energy .eco-icon { color: #f0d36b; }
.eco-icon {
    font: 700 13px/1 ui-monospace, Menlo, monospace;
    text-align: center;
    text-shadow: 0 1px 0 #000;
    z-index: 1;
}
.eco-numbers {
    z-index: 1;
    font: 11px/1 ui-monospace, Menlo, monospace;
    color: #f0f0f0;
    text-shadow: 0 1px 0 #000;
    white-space: nowrap;
}
.eco-numbers-storage { color: #888; }
.eco-income {
    z-index: 1;
    font: 11px/1 ui-monospace, Menlo, monospace;
    color: #6dd06d;
    text-shadow: 0 1px 0 #000;
    min-width: 56px;
    text-align: right;
}
.eco-expense {
    z-index: 1;
    font: 11px/1 ui-monospace, Menlo, monospace;
    color: #d06d6d;
    text-shadow: 0 1px 0 #000;
    min-width: 56px;
    text-align: right;
}
.eco-fill {
    position: absolute;
    inset: 0;
    transform-origin: left;
    pointer-events: none;
    z-index: 0;
    transition: transform 120ms linear;
}
.eco-row-metal .eco-fill {
    background: linear-gradient(180deg, #6f7e88 0%, #4a565f 100%);
    box-shadow: inset 0 -1px 0 rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.08);
}
.eco-row-energy .eco-fill {
    background: linear-gradient(180deg, #d4a93a 0%, #8a6a18 100%);
    box-shadow: inset 0 -1px 0 rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.12);
}
/* Stall indicator: fade the fill and pulse the row border when expense > income. */
.eco-row.eco-stall {
    border-color: #6a1a1a;
    animation: eco-stall-pulse 800ms ease-in-out infinite;
}
@keyframes eco-stall-pulse {
    0%, 100% { box-shadow: inset 0 0 0 1px #441010; }
    50%      { box-shadow: inset 0 0 0 1px #882020; }
}
/* Excess indicator: bright cap on right edge when storage is full. */
.eco-row.eco-excess::after {
    content: '';
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: 3px;
    background: #4af;
    box-shadow: 0 0 6px #4af;
    z-index: 2;
}
`;
        const style = document.createElement('style');
        style.id = 'economy-bar-style';
        style.textContent = css;
        document.head.appendChild(style);
    }
}

class ResourceRow {
    el: HTMLDivElement;
    private fill: HTMLDivElement;
    private numbers: HTMLSpanElement;
    private income: HTMLSpanElement;
    private expense: HTMLSpanElement;

    constructor(icon: string, kind: 'metal' | 'energy') {
        this.el = document.createElement('div');
        this.el.className = `eco-row eco-row-${kind}`;

        this.fill = document.createElement('div');
        this.fill.className = 'eco-fill';
        this.fill.style.transform = 'scaleX(0)';
        this.el.appendChild(this.fill);

        const iconEl = document.createElement('span');
        iconEl.className = 'eco-icon';
        iconEl.textContent = icon;
        this.el.appendChild(iconEl);

        this.numbers = document.createElement('span');
        this.numbers.className = 'eco-numbers';
        this.el.appendChild(this.numbers);

        this.income = document.createElement('span');
        this.income.className = 'eco-income';
        this.el.appendChild(this.income);

        this.expense = document.createElement('span');
        this.expense.className = 'eco-expense';
        this.el.appendChild(this.expense);
    }

    update(current: number, max: number, income: number, expense: number): void {
        const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
        this.fill.style.transform = `scaleX(${ratio})`;

        const cur = formatAmount(current);
        const mx = formatAmount(max);
        this.numbers.innerHTML = `${cur} <span class="eco-numbers-storage">/ ${mx}</span>`;
        this.income.textContent = `+${formatRate(income)}`;
        this.expense.textContent = `-${formatRate(expense)}`;

        // Stall: spending more than coming in for any sustained period.
        // Use a small dead-zone so jitter from the 10Hz update cadence
        // doesn't flicker the indicator.
        const stalling = expense > income + 0.5 && current < max * 0.05;
        this.el.classList.toggle('eco-stall', stalling);

        // Excess: storage full and still earning. Tells the player to
        // build more storage / spend faster.
        const excessing = max > 0 && current >= max * 0.995 && income > 0.5;
        this.el.classList.toggle('eco-excess', excessing);
    }
}

/** Storage / current values: 0..9999 plain, then 1.2k / 12k / 120k. */
function formatAmount(v: number): string {
    if (!isFinite(v)) return '0';
    const a = Math.max(0, v);
    if (a < 1000) return String(Math.round(a));
    if (a < 10000) return (a / 1000).toFixed(2) + 'k';
    if (a < 100000) return (a / 1000).toFixed(1) + 'k';
    return Math.round(a / 1000) + 'k';
}

/** Per-second rates: always one decimal under 100, integer above. */
function formatRate(v: number): string {
    if (!isFinite(v)) return '0';
    const a = Math.max(0, v);
    if (a < 100) return a.toFixed(1);
    if (a < 10000) return Math.round(a).toString();
    return (a / 1000).toFixed(1) + 'k';
}

function formatTooltip(r: ResourceUpdateInfo): string {
    const fmt = (n: number) => n.toFixed(1);
    return [
        `Metal:  ${fmt(r.metal)} / ${fmt(r.maxMetal)}`,
        `  income +${fmt(r.metalIncome)}    pull -${fmt(r.metalPull)}    expense -${fmt(r.metalExpense)}`,
        `  share slack ${fmt(r.metalShare)}    excess -${fmt(r.metalExcess)}`,
        `  sent -${fmt(r.metalSent)}    received +${fmt(r.metalReceived)}`,
        ``,
        `Energy: ${fmt(r.energy)} / ${fmt(r.maxEnergy)}`,
        `  income +${fmt(r.energyIncome)}    pull -${fmt(r.energyPull)}    expense -${fmt(r.energyExpense)}`,
        `  share slack ${fmt(r.energyShare)}    excess -${fmt(r.energyExcess)}`,
        `  sent -${fmt(r.energySent)}    received +${fmt(r.energyReceived)}`,
    ].join('\n');
}
