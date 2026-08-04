/**
 * command-presets.ts — Command composer presets (PLAN-metalstorm-scripting.md
 * §7/task 6)
 *
 * Saves/reloads a *filled* command-composer template ("Assault North Basin —
 * high"), stored per account via the lobby (`POST /api/presets/*`). A
 * preset is a serialised `CommandIntent` — the same slot values the player
 * filled in the composer — never logic: re-loading a preset re-fills the
 * slots and re-issuing it re-runs the normal compile (compile-table.ts).
 * There is no saved trigger, no server-side execution of a preset.
 *
 * Isomorphic-module pattern (configure-once, like client-error-telemetry.ts):
 * `configureCommandPresets` is called once from main.ts with the lobby
 * endpoint + session token; every widget instance shares this one module.
 */

import type { CommandIntent } from './compile-table.js';

export interface CommandPreset {
    name: string;
    intent: CommandIntent;
    /** ISO timestamp string from the server ("" for a preset not yet saved). */
    updatedAt: string;
}

let endpointBase = '';
let authToken = '';

/** Wire the preset channel once per session (main.ts, alongside
 *  configureErrorTelemetry). Safe to call again to refresh the token. */
export function configureCommandPresets(opts: { endpoint?: string; token?: string }): void {
    if (opts.endpoint !== undefined) endpointBase = opts.endpoint.replace(/\/+$/, '');
    if (opts.token !== undefined) authToken = opts.token;
}

function authHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
}

/** List the caller's saved presets, most-recently-updated first. Returns
 *  `[]` on any failure (not logged in yet, offline, server error) — presets
 *  are a QoL layer, never a hard dependency for composing/sending a command. */
export async function listCommandPresets(): Promise<CommandPreset[]> {
    try {
        const resp = await fetch(`${endpointBase}/api/presets/list`, {
            method: 'POST',
            headers: authHeaders(),
            body: '{}',
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        if (!Array.isArray(data?.presets)) return [];
        return data.presets.map((p: any) => ({
            name: String(p.name ?? ''),
            intent: p.intent as CommandIntent,
            updatedAt: String(p.updated_at ?? ''),
        }));
    } catch (e) {
        console.warn('[command-presets] list failed:', e);
        return [];
    }
}

/** Save (create or overwrite) a preset under `name`. Returns an error
 *  message on failure, or null on success — the caller shows the message
 *  directly rather than this module owning any UI. */
export async function saveCommandPreset(name: string, intent: CommandIntent): Promise<string | null> {
    try {
        const resp = await fetch(`${endpointBase}/api/presets/save`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ name, intent }),
        });
        if (resp.ok) return null;
        const data = await resp.json().catch(() => null);
        return data?.error ?? `save failed (${resp.status})`;
    } catch (e) {
        return e instanceof Error ? e.message : 'save failed';
    }
}

/** Delete a saved preset by name. Returns true if a preset was removed. */
export async function deleteCommandPreset(name: string): Promise<boolean> {
    try {
        const resp = await fetch(`${endpointBase}/api/presets/delete`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!resp.ok) return false;
        const data = await resp.json().catch(() => null);
        return Boolean(data?.ok);
    } catch (e) {
        console.warn('[command-presets] delete failed:', e);
        return false;
    }
}
