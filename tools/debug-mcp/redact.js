// redact.js — keep session tokens out of tool output.
//
// /api/rooms/direct answers with `sessions: {username: <bearer token>}` — live
// credentials for every seated account. The launch tools used to echo that map
// verbatim into the conversation transcript. The browser attach URL still has
// to carry the host's token (it is the only way a client can attach to the
// room, and it rides the URL hash), but the raw map is redacted unless the
// caller asks for it.

export const REDACTED = '<redacted — pass revealTokens:true, or attach with open_client({roomId})>';

/** Returns the map with every value replaced, keys (usernames) kept. */
export function redactSessions(sessions, reveal = false) {
    if (!sessions || typeof sessions !== 'object') return sessions;
    if (reveal) return sessions;
    const out = {};
    for (const k of Object.keys(sessions)) out[k] = REDACTED;
    return out;
}

/** Mask a `#token=…` hash fragment in a URL for display. */
export function redactUrlToken(url) {
    return typeof url === 'string' ? url.replace(/#token=[^&#]*/, '#token=<redacted>') : url;
}
