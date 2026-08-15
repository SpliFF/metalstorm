// sqlite-health.js — pure logic for the two ways the MCP's SQLite view can
// silently lie, extracted from server.js so both are unit-testable
// (`node --test tools/debug-mcp/sqlite-health.test.js`).
//
// (a) better-sqlite3 loads its native binding lazily, inside the Database
//     constructor — so a NODE_MODULE_VERSION mismatch (module rebuilt under
//     one node major, MCP run under another) does NOT fail the import; it
//     fails every `new Database(...)`, which the per-tool try/catches used
//     to swallow as "no rows": empty process lists, gameStatus
//     {available:false}, probe_game stuck at 'spawning'. classifyBindingError
//     tells that apart from an ordinary SQLite error (a MISSING DB FILE is
//     deliberately NOT this condition and keeps its existing per-tool paths).
//
// (b) The MCP's SPRING_DB and the lobby's --db are set independently; a
//     hand-started lobby on another --db strips every heartbeat-derived
//     field with no error anywhere. probeSqliteAnnotations detects the
//     signature (lobby reports the process, SQLite opened fine, game_status
//     has no row) and produces the warning the tool results surface.

/**
 * Is `err` a native-binding load failure (wrong NODE_MODULE_VERSION, wrong
 * arch, missing .node file) rather than an ordinary SQLite error?
 * Returns null for anything SQLite itself said (missing file, locked,
 * malformed …) — those keep their existing handling. On a match, returns
 * {builtFor, requires}: the two NODE_MODULE_VERSION numbers from node's own
 * message ("compiled against … using NODE_MODULE_VERSION 127. This version
 * of Node.js requires NODE_MODULE_VERSION 137"), null when absent.
 */
export function classifyBindingError(err) {
    if (!err) return null;
    const msg = String(err.message ?? err);
    const looksLikeBinding = err.code === 'ERR_DLOPEN_FAILED'
        || /NODE_MODULE_VERSION/.test(msg)
        || /was compiled against a different Node\.js version/.test(msg)
        || /Could not locate the bindings file/.test(msg);
    if (!looksLikeBinding) return null;
    const versions = [...msg.matchAll(/NODE_MODULE_VERSION (\d+)/g)].map(m => Number(m[1]));
    return { builtFor: versions[0] ?? null, requires: versions[1] ?? null };
}

/**
 * The reason string every SQLite-backed tool result carries as
 * `sqliteUnavailable` while the binding is unloadable. Names the running
 * node, the module's built-for ABI, and the exact fix.
 */
export function bindingMismatchReason({ builtFor, requires, nodeVersion }) {
    const built = builtFor != null ? `NODE_MODULE_VERSION ${builtFor}` : 'a different node ABI';
    const needs = requires != null ? ` (which needs NODE_MODULE_VERSION ${requires})` : '';
    return `better-sqlite3 native module is built for ${built} but this MCP is running node ${nodeVersion}${needs}`
        + ' — fix: cd tools/debug-mcp && npm rebuild better-sqlite3';
}

/** The ONE unmistakable stderr line written at boot on a binding failure. */
export function bindingMismatchBanner(info) {
    return `[spring-debug-mcp] SQLITE DISABLED: ${bindingMismatchReason(info)}.`
        + ' Until then every SQLite-backed tool result carries sqliteUnavailable'
        + ' (process lists degrade to the lobby API; game_status reads report unavailable, not empty).';
}

/** The (b) warning text, single-sourced so tools cannot drift on wording. */
export function dbDivergenceWarning(port) {
    return 'lobby --db and MCP SPRING_DB may differ; lobby reports the server'
        + ' but game_status has no row — diagnose with'
        + ` curl :${port ?? '<port>'}/api/metrics`;
}

/**
 * The extra fields a probe (or process listing) must carry, given how the
 * game_status read went for one room:
 *   processSource  'lobby' | 'sqlite' | 'none' — where the process row came from
 *   bindingReason  the boot-time mismatch reason, or null (condition (a))
 *   sqliteOpened   the game_status read ran without throwing
 *   statusRow      the room's game_status row, or null/undefined
 *   port           the room's port, for the diagnose hint
 *
 * (a) wins over (b): with the binding broken, "SQLite is available" cannot be
 * established, so only sqliteUnavailable is reported. The (b) warning fires
 * only on the full signature — the lobby (not the SQLite fallback) vouches
 * for the process, SQLite answered, and the row is absent. The caller keeps
 * its phase untouched: these annotate, they never re-phase.
 */
export function probeSqliteAnnotations({ processSource, bindingReason, sqliteOpened, statusRow, port }) {
    if (bindingReason) return { sqliteUnavailable: bindingReason };
    if (processSource === 'lobby' && sqliteOpened && statusRow == null) {
        return { warning: dbDivergenceWarning(port) };
    }
    return {};
}
