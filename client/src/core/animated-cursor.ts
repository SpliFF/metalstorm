// AnimatedCursor — cursor overlay for Spring command modes.
//
// Animated CSS cursors aren't supported by browsers (every implementation
// stops at the first GIF/PNG frame), so we draw the cursor ourselves on
// an absolutely-positioned overlay and hide the native cursor when an
// animated cursor is active.
//
// Manifest format (whitespace-separated, blank lines and `//` comments OK):
//
//   hotspot <topleft|center>            // optional, defaults to topleft
//   frame   <relative/png/path>         <duration_seconds>
//   frame   <relative/png/path>         <duration_seconds>
//   ...
//
// Frames loop unconditionally. ZK ships these at `Anims/cursor*.txt`
// alongside the frame PNGs. Spring is case-insensitive about the
// directory prefix — we try `Anims/`, `anims/`, and the bare path.

interface CursorFrame {
    image: HTMLImageElement;
    durationMs: number;
}

interface LoadedCursor {
    name: string;
    frames: CursorFrame[];
    /** Hotspot in pixels relative to the rendered frame. 'center' resolves
     *  at draw time using the first frame's natural size. */
    hotspot: 'topleft' | 'center';
    /** Total cycle duration in ms, precomputed for modulo math. */
    cycleMs: number;
}

type AssignmentRecord = {
    /** Stem of the .txt manifest filename, e.g. "cursormove" (no extension). */
    file: string;
    /** Optional hotspot override from AssignMouseCursor. Null = read from manifest. */
    hotspotX: number | null;
    hotspotY: number | null;
};

/** Canonical Spring/Recoil command-name → cursor-file mapping (from
 *  CMouseHandler::ReloadCursors in rts/Game/UI/MouseHandler.cpp). Widget
 *  calls to AssignMouseCursor override these per name. */
const DEFAULT_ASSIGNMENTS: ReadonlyArray<readonly [string, string]> = [
    ['Move',          'cursormove'],
    ['Attack',        'cursorattack'],
    ['AttackBad',     'cursorattack'],
    ['Area attack',   'cursorattack'],
    ['Patrol',        'cursorpatrol'],
    ['Fight',         'cursorfight'],
    ['Guard',         'cursordefend'],
    ['Defend',        'cursordefend'],
    ['Repair',        'cursorrepair'],
    ['Reclaim',       'cursorreclamate'],
    ['Resurrect',     'cursorrevive'],
    ['Capture',       'cursorcapture'],
    ['Wait',          'cursorwait'],
    ['DeathWait',     'cursordwatch'],
    ['TimeWait',      'cursortime'],
    ['Load units',    'cursorpickup'],
    ['Unload units',  'cursorunload'],
    ['SelfD',         'cursorselfd'],
    ['DGun',          'cursordgun'],
    ['ManualFire',    'cursormanualfire'],
    ['BuildBad',      'cursorbuildbad'],
    ['BuildGood',     'cursorbuildgood'],
];

export class AnimatedCursor {
    private overlay: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D | null;
    private host: HTMLElement;

    private gameAssetsBaseUrl: string;
    private engineAssetsBaseUrl: string | null;

    /** Per-name cursor descriptors (file path + optional hotspot override). */
    private assignments = new Map<string, AssignmentRecord>();
    /** Cache of loaded cursors keyed by the assignment file stem. Pending
     *  loads are stored as Promises so simultaneous setActive() calls
     *  don't trigger duplicate fetches. */
    private cursorCache = new Map<string, LoadedCursor | Promise<LoadedCursor | null> | null>();

    /** Currently-active cursor name (e.g. "Move"). null = native arrow. */
    private activeName: string | null = null;
    /** The loaded cursor object the renderer is drawing. Cleared whenever
     *  activeName changes; repopulates once the loader resolves. */
    private activeCursor: LoadedCursor | null = null;

    private mouseX = 0;
    private mouseY = 0;
    private startedAt = 0;
    private rafHandle: number | null = null;
    private lastDrawnFrame = -1;

    constructor(host: HTMLElement, lobbyHttpUrl: string, gameId: string) {
        this.host = host;
        this.gameAssetsBaseUrl = `${lobbyHttpUrl}/api/games/data/${gameId}`;
        // Engine-base assets land under /api/data/engine on the lobby. The
        // server may not be serving that route in every deployment; the
        // fallback try just no-ops on 404.
        this.engineAssetsBaseUrl = `${lobbyHttpUrl}/api/data/engine`;

        this.overlay = document.createElement('canvas');
        this.overlay.width = 64;
        this.overlay.height = 64;
        this.overlay.style.position = 'fixed';
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.zIndex = '9999';
        this.overlay.style.left = '-100px';
        this.overlay.style.top = '-100px';
        this.overlay.style.display = 'none';
        document.body.appendChild(this.overlay);
        this.ctx = this.overlay.getContext('2d');

        // Track the cursor across the whole document — switching to a
        // mode-cursor outside the canvas (e.g. a widget hover) still needs
        // an accurate position so the overlay doesn't lag a frame behind
        // the native cursor when we hide it.
        const onMove = (ev: PointerEvent | MouseEvent) => {
            this.mouseX = ev.clientX;
            this.mouseY = ev.clientY;
            if (this.activeCursor) this.scheduleDraw();
        };
        document.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('mousemove', onMove, { passive: true });

        // Pre-register the default Recoil command → file mapping. Widget
        // AssignMouseCursor calls overlay these. Lazy-load: the .txt
        // manifest only fetches when a cursor is first activated.
        for (const [name, file] of DEFAULT_ASSIGNMENTS) {
            this.assignments.set(name, { file, hotspotX: null, hotspotY: null });
        }
    }

    /** Spring.AssignMouseCursor(name, file, hotspotX?, hotspotY?, overwrite?).
     *  `file` is the manifest stem ("cursormove") — we resolve it against
     *  Anims/. If `overwrite` is false and the name already has an
     *  assignment, the call is a no-op (matches Spring). */
    assign(name: string, file: string, hotspotX: number | null = null,
           hotspotY: number | null = null, overwrite = true): void {
        if (!name || !file) return;
        if (!overwrite && this.assignments.has(name)) return;
        // Drop any cached load for the previous file so the next setActive
        // re-fetches the new manifest.
        const prev = this.assignments.get(name);
        if (prev && prev.file !== file) {
            this.cursorCache.delete(prev.file);
        }
        this.assignments.set(name, { file, hotspotX, hotspotY });
        // Invalidate active cursor if the active assignment changed under us.
        if (this.activeName === name) {
            this.activeCursor = null;
            void this.activate(name);
        }
    }

    /** Spring.SetMouseCursor(name) — switch the active cursor. Pass null
     *  / empty string to revert to the native arrow. */
    setActive(name: string | null): void {
        if (!name) {
            if (this.activeName !== null) {
                this.activeName = null;
                this.activeCursor = null;
                this.hideOverlay();
            }
            return;
        }
        if (this.activeName === name) return;
        this.activeName = name;
        this.activeCursor = null;
        void this.activate(name);
    }

    /** Returns the currently-active cursor name (or empty string for the
     *  native arrow). Backs Spring.GetMouseCursor. */
    getActive(): string {
        return this.activeName ?? '';
    }

    dispose(): void {
        if (this.rafHandle !== null) {
            cancelAnimationFrame(this.rafHandle);
            this.rafHandle = null;
        }
        this.hideOverlay();
        this.overlay.remove();
        this.assignments.clear();
        this.cursorCache.clear();
        this.activeCursor = null;
        this.activeName = null;
    }

    private async activate(name: string): Promise<void> {
        const assignment = this.assignments.get(name);
        if (!assignment) {
            this.hideOverlay();
            return;
        }
        const loaded = await this.loadCursor(assignment.file);
        // Race guard: another setActive may have run while we were loading.
        if (this.activeName !== name) return;
        if (!loaded) {
            this.hideOverlay();
            return;
        }
        // Apply per-assignment hotspot override.
        const finalCursor: LoadedCursor = (assignment.hotspotX !== null && assignment.hotspotY !== null)
            ? { ...loaded, hotspot: 'topleft' }
            : loaded;
        this.activeCursor = finalCursor;
        this.startedAt = performance.now();
        this.lastDrawnFrame = -1;
        this.showOverlay();
        this.scheduleDraw();
    }

    private async loadCursor(file: string): Promise<LoadedCursor | null> {
        const cached = this.cursorCache.get(file);
        if (cached !== undefined) {
            // Either a resolved value or a pending promise — both are fine
            // to return as-is, callers await uniformly.
            return Promise.resolve(cached);
        }
        const promise = this.fetchAndParseCursor(file);
        this.cursorCache.set(file, promise);
        const result = await promise;
        this.cursorCache.set(file, result);
        return result;
    }

    private async fetchAndParseCursor(file: string): Promise<LoadedCursor | null> {
        // Try game assets, then engine base. Both Anims/ and anims/ —
        // Spring resolves these case-insensitively but the lobby static
        // file route is case-sensitive on most filesystems.
        const candidates: string[] = [];
        for (const dir of ['Anims', 'anims']) {
            candidates.push(`${this.gameAssetsBaseUrl}/${dir}/${file}.txt`);
        }
        if (this.engineAssetsBaseUrl) {
            for (const dir of ['Anims', 'anims']) {
                candidates.push(`${this.engineAssetsBaseUrl}/${dir}/${file}.txt`);
            }
        }
        let manifestUrl: string | null = null;
        let manifestText: string | null = null;
        for (const url of candidates) {
            try {
                const res = await fetch(url);
                if (res.ok) {
                    manifestText = await res.text();
                    manifestUrl = url;
                    break;
                }
            } catch {
                // Network error — try next candidate.
            }
        }
        if (!manifestText || !manifestUrl) return null;

        const baseDir = manifestUrl.slice(0, manifestUrl.lastIndexOf('/'));
        const parsed = parseManifest(manifestText);

        // Frame paths in the manifest are game-root-relative
        // ("anims/cursormove_0.png"). The base for the PNGs is the same
        // game-data root we used for the .txt — strip the trailing
        // `Anims/<file>.txt` to get back to it.
        const gameRoot = stripAnimsManifestSuffix(manifestUrl);
        const frames: CursorFrame[] = [];
        for (const f of parsed.frames) {
            // The manifest path can be either "anims/foo.png" (game-root
            // relative) or just "foo.png" (relative to the manifest dir).
            const url = /^[Aa]nims\//.test(f.path)
                ? `${gameRoot}/${f.path}`
                : `${baseDir}/${f.path}`;
            const img = await loadImage(url);
            if (!img) continue;
            frames.push({ image: img, durationMs: Math.max(1, f.duration * 1000) });
        }
        if (frames.length === 0) return null;
        return {
            name: file,
            frames,
            hotspot: parsed.hotspot,
            cycleMs: frames.reduce((s, f) => s + f.durationMs, 0),
        };
    }

    private showOverlay(): void {
        this.overlay.style.display = 'block';
        // Hide the OS cursor over the host so only ours shows. We can't
        // hide it document-wide (modal dialogs, browser chrome) so we
        // scope to the host element the game runs inside.
        this.host.style.cursor = 'none';
    }

    private hideOverlay(): void {
        this.overlay.style.display = 'none';
        this.host.style.cursor = '';
    }

    private scheduleDraw(): void {
        if (this.rafHandle !== null) return;
        this.rafHandle = requestAnimationFrame(() => {
            this.rafHandle = null;
            this.draw();
        });
    }

    private draw(): void {
        const cursor = this.activeCursor;
        const ctx = this.ctx;
        if (!cursor || !ctx) return;
        const elapsed = performance.now() - this.startedAt;
        const cyclePos = elapsed % cursor.cycleMs;
        let acc = 0;
        let frameIdx = 0;
        for (let i = 0; i < cursor.frames.length; i++) {
            acc += cursor.frames[i].durationMs;
            if (cyclePos < acc) { frameIdx = i; break; }
        }
        const frame = cursor.frames[frameIdx];
        const w = frame.image.naturalWidth || 32;
        const h = frame.image.naturalHeight || 32;

        // Resize the canvas to fit the largest frame so we don't crop.
        if (this.overlay.width !== w || this.overlay.height !== h) {
            this.overlay.width = w;
            this.overlay.height = h;
        } else if (frameIdx === this.lastDrawnFrame) {
            // Same frame, mouse moved — just reposition.
            const assign = this.activeName ? this.assignments.get(this.activeName) : undefined;
            const hx = assign?.hotspotX ?? (cursor.hotspot === 'center' ? w / 2 : 0);
            const hy = assign?.hotspotY ?? (cursor.hotspot === 'center' ? h / 2 : 0);
            this.overlay.style.left = `${this.mouseX - hx}px`;
            this.overlay.style.top  = `${this.mouseY - hy}px`;
            return;
        }
        this.lastDrawnFrame = frameIdx;

        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(frame.image, 0, 0, w, h);

        const assign = this.activeName ? this.assignments.get(this.activeName) : undefined;
        const hx = assign?.hotspotX ?? (cursor.hotspot === 'center' ? w / 2 : 0);
        const hy = assign?.hotspotY ?? (cursor.hotspot === 'center' ? h / 2 : 0);
        this.overlay.style.left = `${this.mouseX - hx}px`;
        this.overlay.style.top  = `${this.mouseY - hy}px`;

        // Schedule the next animation frame so the cycle keeps advancing
        // even when the cursor isn't moving.
        if (cursor.frames.length > 1) this.scheduleDraw();
    }
}

/** Strips a trailing `Anims/<...>.txt` (any case, any nesting depth under
 *  Anims/) off a manifest URL to recover the game-data root. Exported for
 *  unit testing — some cursor packs nest the manifest a level deeper
 *  (`Anims/<pack>/<file>.txt`) rather than directly under `Anims/`. */
export function stripAnimsManifestSuffix(manifestUrl: string): string {
    return manifestUrl.replace(/\/[Aa]nims\/.+\.txt$/, '');
}

interface ParsedManifest {
    hotspot: 'topleft' | 'center';
    frames: { path: string; duration: number }[];
}

function parseManifest(text: string): ParsedManifest {
    const frames: { path: string; duration: number }[] = [];
    let hotspot: 'topleft' | 'center' = 'topleft';
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//')) continue;
        const tokens = line.split(/\s+/);
        const verb = tokens[0].toLowerCase();
        if (verb === 'hotspot' && tokens[1]) {
            hotspot = tokens[1].toLowerCase() === 'center' ? 'center' : 'topleft';
        } else if (verb === 'frame' && tokens.length >= 3) {
            const duration = Number(tokens[2]);
            if (Number.isFinite(duration) && duration > 0) {
                frames.push({ path: tokens[1], duration });
            }
        }
    }
    return { hotspot, frames };
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}
