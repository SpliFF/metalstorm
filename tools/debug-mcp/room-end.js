// Decision logic for the MCP `end_game` tool's graceful path
// (POST /api/admin/rooms/end, PLAN-test-automation P4).
//
// Extracted from server.js because the interesting part — telling three
// different 404s apart — is pure and deserves tests, and server.js starts a
// stdio server on import.
//
// THREE 404s exist in the wild and they must not be confused:
//   1. the route is not registered at all → a lobby binary older than P4.
//      Fall back to the MCP-local SIGTERM→poll→SIGKILL path.
//   2. the P4 route's own `{"error":"unknown roomId"}` → the lobby has never
//      heard of this room. Report it. Falling back here would kill whatever
//      pid the local resolver guessed at, violating the refuse-with-candidates
//      rule that destructive verbs live by.
//   3. /api/rooms/direct's feature-latch 404 — irrelevant to this route (it has
//      no latch), but it primes the wrong reflex, so the rule is written down.
//
// Anything else non-2xx (400/401/403/500) is a real error and NEVER falls back:
// a 403 fall-through would quietly convert an auth misconfiguration into an
// unaudited kill.

/**
 * @param {number} status  HTTP status from POST /api/admin/rooms/end
 * @param {string} bodyText  raw response body
 * @returns {{action:'report'|'fallback'|'error', error?:string, report?:object}}
 */
export function classifyEndResponse(status, bodyText) {
    const body = typeof bodyText === 'string' ? bodyText : '';
    if (status === 404) {
        // Only the P4 route answers 404 with a JSON body naming the room. An
        // unregistered route's 404 is the lobby's generic not-found text.
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not JSON → route-level */ }
        if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
            && /unknown\s+roomId/i.test(parsed.error)) {
            return { action: 'error', error: `unknown roomId — the lobby has no such room. (No fallback kill: destructive verbs never guess a target.)` };
        }
        return { action: 'fallback' };
    }
    if (status < 200 || status >= 300) {
        return { action: 'error', error: `rooms/end failed (${status}): ${body.trim() || '(empty body)'}` };
    }
    let report;
    try { report = JSON.parse(body); }
    catch { return { action: 'error', error: `rooms/end returned ${status} with a non-JSON body: ${body.slice(0, 300)}` }; }
    return { action: 'report', report };
}
