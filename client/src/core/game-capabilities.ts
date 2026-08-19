/**
 * game-capabilities — what the *game* says about itself, read off the
 * lobby's `/api/games` discovery payload.
 *
 * PLAN-endtoend.md D9. Metalstorm has no metal/energy economy (authority
 * replaces both), yet `#economy-bar` rendered `M 0 / 1000k  E 0 / 1000k` at
 * the top of the screen for every frame of every match — a dead surface on
 * the player's primary view. The fix is data-driven, following the call
 * `archived` made for D26: the game declares the fact in its own config
 * (`resourceEconomy = false` in `modinfo.lua`), `GameDiscovery` reads it and
 * `/api/games` relays it. This module is the client-side seam, kept out of
 * `main.ts` so the parse rule is testable — the D61 lesson (fire 41) is that
 * an unguarded seam between two files is exactly where a surface goes wrong
 * without any test noticing.
 *
 * Fallback direction, stated once: **anything other than an explicit
 * `false` means the game HAS a resource economy.** A missing entry, an
 * absent field, a failed `/api/games` fetch and an unknown game id all keep
 * the legacy HUD. Blanking a surface a game needs is the worse failure, and
 * it is also the one nobody would attribute to a discovery hiccup.
 */

/** One entry of the `/api/games` array, narrowed to what we read here. */
export interface GameCapabilityEntry {
    id?: unknown;
    resourceEconomy?: unknown;
}

/**
 * True when `gameId`'s discovery entry does not explicitly disclaim the
 * metal/energy economy. `games` is the raw parsed `/api/games` body, so it
 * is typed as `unknown` — this is the boundary that validates it.
 */
export function hasResourceEconomy(games: unknown, gameId: string): boolean {
    if (!gameId || !Array.isArray(games)) return true;
    const entry = (games as GameCapabilityEntry[]).find(
        (g) => g && typeof g === 'object' && g.id === gameId);
    if (!entry) return true;
    return entry.resourceEconomy !== false;
}
