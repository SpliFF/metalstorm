/**
 * FactoryQueuePanel — right-dock list showing the production queue for the
 * currently-selected factory (PLAN-playable.md G4, ZK Phase D item 4).
 *
 * Same "pure renderer" shape as BuildMenu/EconomyBar: the worker (which owns
 * selection + defs + the command-queue cache) resolves the selected factory's
 * queue into consecutive same-defId runs and pushes them via
 * `gp:sceneState.factoryQueue`; this panel only renders rows and posts intent
 * back (`gp:removeFactoryOrder`) — it never touches the command queue itself.
 *
 * Each row shows the buildPic thumbnail, human name, and a `×N` count badge.
 * Left-click pops one instance off the tail of the row (the most recently
 * queued one — CMD.REMOVE by tag doesn't care which physical instance, since
 * they're identical unit types). The small `✕` button cancels the whole row
 * in one message. There is no reorder control this session — see the
 * PLAN-playable.md G4 field notes for why it was scoped out.
 */
import type { FactoryQueueTile } from './game-worker-protocol.js';

export interface FactoryQueuePanelCallbacks {
    /** Pop one instance off the tail of a row (left-click a row). */
    onRemoveOne: (unitId: number, tag: number) => void;
    /** Cancel every instance in a row (click its ✕ button). */
    onRemoveAll: (unitId: number, tags: number[]) => void;
}

export interface FactoryQueuePanelOptions {
    /** Lobby HTTP base, e.g. `http://localhost:8011`. */
    lobbyHttpUrl: string;
    /** Game id, e.g. `zk` — used to resolve buildPic asset URLs. */
    gameId: string;
}

export class FactoryQueuePanel {
    private root: HTMLDivElement;
    private list: HTMLDivElement;
    private callbacks: FactoryQueuePanelCallbacks;
    private buildPicBase: string;

    private rows: FactoryQueueTile[] = [];

    constructor(opts: FactoryQueuePanelOptions, callbacks: FactoryQueuePanelCallbacks) {
        this.callbacks = callbacks;
        this.buildPicBase = opts.gameId
            ? `${opts.lobbyHttpUrl}/api/games/data/${encodeURIComponent(opts.gameId)}/unitpics`
            : '';

        this.root = document.createElement('div');
        this.root.id = 'factory-queue-panel';
        this.root.style.display = 'none';

        this.list = document.createElement('div');
        this.list.className = 'factory-queue-list';
        this.root.appendChild(this.list);

        document.body.appendChild(this.root);
        this.injectStyles();
    }

    /** Feed the worker-resolved queue rows (gp:sceneState.factoryQueue). */
    setRows(rows: FactoryQueueTile[]): void {
        this.rows = rows;
        this.render();
    }

    /** Probe used to swallow clicks landing on the panel (cursor-over-UI). */
    isCursorOver(x: number, y: number): boolean {
        if (this.root.style.display === 'none') return false;
        const r = this.root.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    private render(): void {
        if (this.rows.length === 0) {
            this.root.style.display = 'none';
            this.list.replaceChildren();
            return;
        }

        const rowEls: HTMLDivElement[] = [];
        for (const row of this.rows) {
            const el = document.createElement('div');
            el.className = 'factory-queue-row';
            el.dataset.defId = String(row.defId);

            const img = document.createElement('img');
            img.className = 'factory-queue-pic';
            img.draggable = false;
            img.alt = row.humanName || row.name || `def ${row.defId}`;
            const pic = row.buildPic;
            if (pic && this.buildPicBase) {
                img.src = `${this.buildPicBase}/${pic}`;
                let triedLower = false;
                img.addEventListener('error', () => {
                    if (!triedLower && pic !== pic.toLowerCase()) {
                        triedLower = true;
                        img.src = `${this.buildPicBase}/${pic.toLowerCase()}`;
                    } else {
                        img.classList.add('factory-queue-pic-missing');
                    }
                });
            } else {
                img.classList.add('factory-queue-pic-missing');
            }
            el.appendChild(img);

            const name = document.createElement('span');
            name.className = 'factory-queue-name';
            name.textContent = row.humanName || row.name || `def ${row.defId}`;
            el.appendChild(name);

            // PLAN-latency L4.2: `count` spans the merged view, so it can
            // include orders the server has not echoed yet. Show the
            // unconfirmed tail separately (`×2 +1`) rather than folding it in —
            // the whole row is otherwise indistinguishable from an
            // authoritative one, and only the confirmed part can be cancelled.
            const count = document.createElement('span');
            count.className = 'factory-queue-count';
            count.textContent = `×${row.count}`;
            el.appendChild(count);
            if (row.pending > 0) {
                const pend = document.createElement('span');
                pend.className = 'factory-queue-pending';
                pend.textContent = `+${row.pending}`;
                pend.title = `${row.pending} order(s) sent, awaiting the server`;
                el.appendChild(pend);
            }

            // A row that is *entirely* unconfirmed has no server tag to
            // address, so both cancel affordances are inert — disable them
            // rather than firing a CMD.REMOVE the server would ignore. It
            // resolves within a round trip.
            const cancellable = row.tags.length > 0;
            const cancel = document.createElement('button');
            cancel.className = 'factory-queue-cancel';
            cancel.textContent = '✕';
            cancel.disabled = !cancellable;
            cancel.title = cancellable
                ? `Cancel all ${row.tags.length} confirmed`
                : 'Awaiting server confirmation';
            cancel.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!cancellable) return;
                this.callbacks.onRemoveAll(row.unitId, row.tags.slice());
            });
            el.appendChild(cancel);

            el.title = `${row.humanName || row.name} ×${row.count}`
                + (row.pending > 0 ? ` (${row.pending} awaiting server)` : '')
                + `\nClick to cancel one, ${'✕'} to cancel all`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const lastTag = row.tags[row.tags.length - 1];
                if (lastTag !== undefined) this.callbacks.onRemoveOne(row.unitId, lastTag);
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
            rowEls.push(el);
        }
        this.list.replaceChildren(...rowEls);
        this.root.style.display = 'block';
    }

    private injectStyles(): void {
        if (document.getElementById('factory-queue-panel-style')) return;
        const css = `
#factory-queue-panel {
    position: fixed;
    top: 48px;
    right: 8px;
    z-index: 20;
    background: linear-gradient(180deg, #1a1d22 0%, #0f1114 100%);
    border: 1px solid #2a2f38;
    border-top-color: #3a4150;
    border-radius: 4px;
    padding: 4px;
    pointer-events: auto;
    box-shadow: 0 0 0 1px #000, 0 4px 14px rgba(0, 0, 0, 0.6);
    width: 220px;
    max-height: 40vh;
    overflow-y: auto;
}
.factory-queue-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}
.factory-queue-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 4px;
    background: #161a20;
    border: 1px solid #000;
    border-top-color: #2c323d;
    border-left-color: #232831;
    border-radius: 2px;
    cursor: pointer;
    color: #e0e0e0;
    font: 11px/1.1 system-ui, sans-serif;
    transition: border-color 80ms linear;
}
.factory-queue-row:hover {
    border-color: #6aa9ff;
    border-top-color: #9bc4ff;
}
.factory-queue-pic {
    width: 24px;
    height: 24px;
    object-fit: cover;
    image-rendering: -webkit-optimize-contrast;
    background: #0a0c10;
    border-radius: 2px;
    pointer-events: none;
    user-select: none;
    flex-shrink: 0;
}
.factory-queue-pic-missing {
    background: repeating-linear-gradient(
        45deg,
        #1a1d22 0 4px,
        #14161a 4px 8px
    );
}
.factory-queue-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
}
.factory-queue-count {
    flex-shrink: 0;
    color: #d8d4b0;
    font: 11px/1.1 ui-monospace, Menlo, monospace;
    pointer-events: none;
}
.factory-queue-pending {
    flex-shrink: 0;
    padding: 0 3px;
    border: 1px dashed #79b0ff;
    border-radius: 6px;
    color: #b9d5ff;
    font: 10px/1.2 ui-monospace, Menlo, monospace;
    pointer-events: none;
}
.factory-queue-cancel {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    color: #888;
    font-size: 11px;
    line-height: 18px;
    cursor: pointer;
}
.factory-queue-cancel:hover:not(:disabled) {
    color: #e05050;
}
.factory-queue-cancel:disabled {
    color: #3a3f48;
    cursor: default;
}
#factory-queue-panel::-webkit-scrollbar { width: 6px; }
#factory-queue-panel::-webkit-scrollbar-track { background: transparent; }
#factory-queue-panel::-webkit-scrollbar-thumb { background: #2a2f38; border-radius: 3px; }
#factory-queue-panel::-webkit-scrollbar-thumb:hover { background: #3a4150; }
`;
        const style = document.createElement('style');
        style.id = 'factory-queue-panel-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    dispose(): void {
        this.root.remove();
        document.getElementById('factory-queue-panel-style')?.remove();
        this.rows = [];
    }
}
