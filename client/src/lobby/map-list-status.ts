/**
 * What the map selector should show — the one decision that made defect D33
 * invisible to players.
 *
 * D33: the lobby's SQLite handle faulted mid-session. `/api/maps` returned an
 * empty list, the map grid rendered "No maps found in content/maps/", and a
 * whole session was spent looking for missing map files that were never
 * missing. A failed read and an empty result are different facts and must
 * never collapse into the same message.
 *
 * Kept as a pure function so the precedence rule is testable without a DOM.
 */

export type MapListStatus =
    /// The last /api/maps call failed. `detail` is the server's reason.
    | { kind: 'error'; detail: string }
    /// The call succeeded and the server genuinely has no maps installed.
    | { kind: 'empty' }
    /// The call succeeded and there are maps to render.
    | { kind: 'ok' };

export function mapListStatus(mapCount: number, loadError: string): MapListStatus {
    // Error wins over emptiness: a faulted read yields zero maps too, and
    // reporting that as "no maps installed" is the bug this guards.
    if (loadError) return { kind: 'error', detail: loadError };
    if (mapCount === 0) return { kind: 'empty' };
    return { kind: 'ok' };
}
