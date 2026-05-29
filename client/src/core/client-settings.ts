/**
 * ClientSettings — the single source of truth for user-facing settings.
 *
 * See PLAN-settings.md. Any game's in-game menu drives this store through
 * the standard Lua config API (`Spring.GetConfigInt` / `SetConfigInt`,
 * which delegate here — see lua-spring-api.ts), and every native
 * subsystem that owns a setting *subscribes* to its key and applies the
 * change live. The store is game-agnostic: it knows nothing about ZK,
 * BAR, or any specific menu.
 *
 * Two layers of settings share this one store (PLAN-settings.md §"two
 * layers"):
 *   - game/widget settings  (scope 'game'): gameplay + widget prefs
 *   - engine/render settings (scope 'engine'/'client'): shadow quality,
 *     particle caps, draw distance, volumes, …
 *
 * Backing store is `localStorage`, keyed `springConfig.<key>` to stay
 * compatible with the keys `Spring.SetConfigInt` already wrote. Account-
 * synced settings are a later concern (PLAN-settings.md "Deferred"); the
 * public API is deliberately small so it can be made async if that flips.
 */

export type SettingScope = 'engine' | 'game' | 'client';
export type SettingType = 'int' | 'float' | 'bool' | 'string';

/** Static metadata for a known setting. Unknown keys still work (games
 *  set arbitrary keys); a registry entry just supplies a default, type,
 *  validation range, and scope, and lets the key take part in presets +
 *  the graphics panel. */
export interface SettingDef {
    key: string;
    type: SettingType;
    /** Default applied when no stored value exists. */
    default: number | boolean | string;
    scope: SettingScope;
    /** Numeric clamp (inclusive). Ignored for bool/string. */
    min?: number;
    max?: number;
    /** Allowed discrete values (e.g. shadow map sizes). Enforced if set. */
    enum?: Array<number | string>;
    /** Human label for the settings panel. */
    label?: string;
    /** True when changing this needs a renderer/CSM rebuild — the panel
     *  shows "applies on restart" and subsystems may defer. */
    requiresRestart?: boolean;
}

export type SettingValue = number | boolean | string;
type Subscriber = (value: SettingValue, key: string) => void;

const STORAGE_PREFIX = 'springConfig.';

/** Coerce a raw stored string to the registry type. */
function parseStored(raw: string, type: SettingType): SettingValue {
    switch (type) {
        case 'int':    { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : 0; }
        case 'float':  { const n = parseFloat(raw);   return Number.isFinite(n) ? n : 0; }
        case 'bool':   return raw === '1' || raw === 'true';
        case 'string': return raw;
    }
}

/** Serialise a value the way the existing config store expects (bools as
 *  `0`/`1`, matching Spring's int-backed booleans). */
function serialise(value: SettingValue, type: SettingType): string {
    if (type === 'bool') return value ? '1' : '0';
    return String(value);
}

function clampToDef(def: SettingDef | undefined, value: SettingValue): SettingValue {
    if (!def) return value;
    if (def.enum && !def.enum.includes(value as number | string)) {
        // Snap to nearest for numeric enums; otherwise fall back to default.
        if (def.type === 'int' || def.type === 'float') {
            const nums = def.enum as number[];
            const v = Number(value);
            return nums.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
        }
        return def.default;
    }
    if ((def.type === 'int' || def.type === 'float') && typeof value === 'number') {
        let v = value;
        if (def.min != null) v = Math.max(def.min, v);
        if (def.max != null) v = Math.min(def.max, v);
        return def.type === 'int' ? Math.round(v) : v;
    }
    return value;
}

class ClientSettingsStore {
    private registry = new Map<string, SettingDef>();
    private perKey = new Map<string, Set<Subscriber>>();
    private global = new Set<Subscriber>();
    /** In-memory cache so reads don't hit localStorage every frame and so
     *  the store still works if localStorage is unavailable. */
    private cache = new Map<string, SettingValue>();

    /** Register known settings. Idempotent; later calls override. */
    register(defs: SettingDef[]): void {
        for (const d of defs) this.registry.set(d.key, d);
    }

    getDef(key: string): SettingDef | undefined {
        return this.registry.get(key);
    }

    /** True if the key has an explicitly stored value (vs. falling back to
     *  the registry default). Reads the backing store directly — the cache
     *  may hold a defaulted value from a prior get(). Used for one-time
     *  migrations. */
    has(key: string): boolean {
        return this.readRaw(key) != null;
    }

    /** All registered defs, optionally filtered by scope — used by the
     *  graphics panel to enumerate its controls. */
    defs(scope?: SettingScope): SettingDef[] {
        const all = [...this.registry.values()];
        return scope ? all.filter(d => d.scope === scope) : all;
    }

    private readRaw(key: string): string | null {
        try { return localStorage.getItem(STORAGE_PREFIX + key); }
        catch { return null; }
    }

    private writeRaw(key: string, value: string): void {
        try { localStorage.setItem(STORAGE_PREFIX + key, value); }
        catch { /* localStorage may be unavailable; cache still holds it */ }
    }

    /** Typed read. Returns the registry default (or `fallback`) when no
     *  value is stored. Type is inferred from the registry; unknown keys
     *  default to string unless `fallback` hints a type. */
    get(key: string, fallback?: SettingValue): SettingValue {
        if (this.cache.has(key)) return this.cache.get(key)!;
        const def = this.registry.get(key);
        const type: SettingType = def?.type
            ?? (typeof fallback === 'number' ? 'float'
              : typeof fallback === 'boolean' ? 'bool' : 'string');
        const raw = this.readRaw(key);
        let value: SettingValue;
        if (raw != null) value = parseStored(raw, type);
        else if (def != null) value = def.default;
        else if (fallback !== undefined) value = fallback;
        else value = '';
        this.cache.set(key, value);
        return value;
    }

    /** The serialised wire form of a value (bools as `0`/`1`), matching
     *  what `set()` persists. Used to seed the worker's config cache so
     *  its `GetConfigInt` parses the same representation. */
    getStored(key: string): string {
        const def = this.registry.get(key);
        const type: SettingType = def?.type ?? 'string';
        return serialise(this.get(key), type);
    }

    getInt(key: string, fallback = 0): number { return Number(this.get(key, fallback)); }
    getFloat(key: string, fallback = 0): number { return Number(this.get(key, fallback)); }
    getBool(key: string, fallback = false): boolean { return Boolean(this.get(key, fallback)); }
    getString(key: string, fallback = ''): string { return String(this.get(key, fallback)); }

    /** Typed write. Validates against the registry def (clamp/enum),
     *  persists, and notifies subscribers. Returns the stored value. */
    set(key: string, value: SettingValue): SettingValue {
        const def = this.registry.get(key);
        // The bridge (and Lua) hand us raw strings; coerce to the
        // registry type so subscribers receive a properly-typed value.
        const coerced: SettingValue = (typeof value === 'string' && def)
            ? parseStored(value, def.type) : value;
        const v = clampToDef(def, coerced);
        const type: SettingType = def?.type
            ?? (typeof v === 'number' ? 'float'
              : typeof v === 'boolean' ? 'bool' : 'string');
        this.cache.set(key, v);
        this.writeRaw(key, serialise(v, type));
        this.notify(key, v);
        return v;
    }

    private notify(key: string, value: SettingValue): void {
        const subs = this.perKey.get(key);
        if (subs) for (const cb of subs) { try { cb(value, key); } catch { /* subscriber error */ } }
        for (const cb of this.global) { try { cb(value, key); } catch { /* subscriber error */ } }
    }

    /** Subscribe to changes for one key. If `fireNow`, the callback is
     *  invoked immediately with the current value (handy for subsystems
     *  that want to apply on boot and on every later change with one
     *  registration). Returns an unsubscribe fn. */
    subscribe(key: string, cb: Subscriber, fireNow = false): () => void {
        let subs = this.perKey.get(key);
        if (!subs) { subs = new Set(); this.perKey.set(key, subs); }
        subs.add(cb);
        if (fireNow) { try { cb(this.get(key), key); } catch { /* ok */ } }
        return () => { subs!.delete(cb); };
    }

    /** Subscribe to every change (used by debug tooling / the panel). */
    subscribeAll(cb: Subscriber): () => void {
        this.global.add(cb);
        return () => { this.global.delete(cb); };
    }

    /** Apply a named preset: a batch `set()` over the keys it names. The
     *  user can still override any single key afterward (PLAN-settings.md
     *  §5 — individual settings primary, preset is a convenience). */
    applyPreset(name: string): void {
        const preset = PRESETS[name];
        if (!preset) return;
        for (const [key, value] of Object.entries(preset)) this.set(key, value);
        this.set('gfx.quality', name);
    }
}

/**
 * Graphics presets — convenience batch-sets over the individual gfx.*
 * keys. NOT exclusive: choosing a preset writes these values, after which
 * any single key can be overridden. Values are placeholders to tune once
 * measured (PLAN-settings.md §5); 'medium' is the default (Apple M2-class
 * baseline).
 */
export const PRESETS: Record<string, Record<string, SettingValue>> = {
    low: {
        'gfx.shadowMapSize':  1024,
        'gfx.shadowFiltering': 0,   // 0=low 1=medium 2=high
        'gfx.msaaSamples':    1,
        'gfx.fxaa':           false,
        'gfx.renderScale':    1.0,
        'gfx.anisotropy':     1,
    },
    medium: {
        'gfx.shadowMapSize':  2048,
        'gfx.shadowFiltering': 1,
        'gfx.msaaSamples':    2,
        'gfx.fxaa':           true,
        'gfx.renderScale':    1.0,
        'gfx.anisotropy':     4,
    },
    high: {
        'gfx.shadowMapSize':  4096,
        'gfx.shadowFiltering': 2,
        'gfx.msaaSamples':    4,
        'gfx.fxaa':           true,
        'gfx.renderScale':    1.0,
        'gfx.anisotropy':     8,
    },
};

/**
 * The known-setting registry. Engine/render keys get a `gfx.` prefix to
 * keep them out of the way of game-set keys (`GroundDecals`, `MaxParticles`
 * …, which games write directly and which the §4 bridge reads). The
 * graphics-page keys here drive the §6 Chili panel and §5 shadow/AA reads.
 */
const REGISTRY: SettingDef[] = [
    // Client-level graphics knobs (PLAN-settings.md §5) — no game option.
    { key: 'gfx.quality', type: 'string', default: 'medium', scope: 'client',
      enum: ['low', 'medium', 'high', 'custom'], label: 'Graphics Quality' },
    { key: 'gfx.shadowMapSize', type: 'int', default: 2048, scope: 'client',
      enum: [1024, 2048, 4096], label: 'Shadow Resolution', requiresRestart: true },
    { key: 'gfx.shadowFiltering', type: 'int', default: 1, scope: 'client',
      min: 0, max: 2, label: 'Shadow Filtering', requiresRestart: true },
    { key: 'gfx.msaaSamples', type: 'int', default: 2, scope: 'client',
      enum: [1, 2, 4, 8], label: 'Anti-aliasing (MSAA)', requiresRestart: true },
    { key: 'gfx.fxaa', type: 'bool', default: true, scope: 'client',
      label: 'FXAA' },
    { key: 'gfx.renderScale', type: 'float', default: 1.0, scope: 'client',
      min: 0.5, max: 2.0, label: 'Render Scale', requiresRestart: true },
    { key: 'gfx.anisotropy', type: 'int', default: 4, scope: 'client',
      enum: [1, 2, 4, 8, 16], label: 'Anisotropic Filtering' },

    // Engine options a game's menu sets (PLAN-settings.md §4). Defaults
    // match Spring's so an unset key reads as "on/full".
    { key: 'GroundDecals', type: 'int', default: 1, scope: 'engine',
      min: 0, max: 1, label: 'Ground Decals' },
    { key: 'MaxParticles', type: 'int', default: 10000, scope: 'engine',
      min: 1000, max: 50000, label: 'Particle Density' },
    { key: 'UnitLodDist', type: 'int', default: 1000, scope: 'engine',
      min: 100, max: 10000, label: 'Draw Distance' },
    { key: 'UnitIconDist', type: 'int', default: 200, scope: 'engine',
      min: 50, max: 2000, label: 'Icon Distance' },
    { key: 'AdvUnitShading', type: 'int', default: 1, scope: 'engine',
      min: 0, max: 1, label: 'Shiny Units' },

    // Audio volumes (PLAN-settings.md §7). ZK's epicmenu scale is 0..100;
    // AudioManager divides by 100. Single source of truth — the old
    // audio.master / audio.channel.* keys migrate into these on first run.
    { key: 'snd_volmaster',   type: 'int', default: 100, scope: 'client',
      min: 0, max: 100, label: 'Master Volume' },
    { key: 'snd_volgeneral',  type: 'int', default: 100, scope: 'client',
      min: 0, max: 100, label: 'General Volume' },
    { key: 'snd_volbattle',   type: 'int', default: 100, scope: 'client',
      min: 0, max: 100, label: 'Battle Volume' },
    { key: 'snd_volunitreply', type: 'int', default: 100, scope: 'client',
      min: 0, max: 100, label: 'Unit Reply Volume' },
    { key: 'snd_volui',       type: 'int', default: 100, scope: 'client',
      min: 0, max: 100, label: 'UI Volume' },
    { key: 'snd_volmusic',    type: 'int', default: 30, scope: 'client',
      min: 0, max: 100, label: 'Music Volume' },
];

/** Process-wide singleton. */
export const clientSettings = new ClientSettingsStore();
clientSettings.register(REGISTRY);

// Expose for DevTools live-tuning (mirrors window.__csm etc.).
(window as unknown as { __settings: unknown }).__settings = clientSettings;
