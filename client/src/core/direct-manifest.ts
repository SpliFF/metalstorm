/**
 * `?direct=<manifest>` manifest parsing (PLAN-quickstart.md Part A).
 *
 * The one non-obvious failure this guards is the Vite/SPA history fallback:
 * a manifest that exists in `manifests/` but was never copied to
 * `client/public/` is NOT a 404. The dev server (and the production static
 * server) answer any unmatched path with `index.html` at HTTP 200, so the
 * fetch succeeds and only `JSON.parse` fails — with `Unexpected token '<'`,
 * which names neither the manifest nor the missing copy. That has cost this
 * project two separate investigations (PLAN-maps M8b finding 4, and again on
 * `techno_lands_verify_solo.json`), so the diagnosis is spelled out here.
 */

/** Parse a `?direct=` manifest body, distinguishing an SPA-fallback HTML
 *  page from genuinely malformed JSON. Throws on either. */
export function parseDirectManifest(url: string, body: string): unknown {
    if (looksLikeHtml(body))
        throw new Error(
            `?direct: '${url}' served an HTML page, not JSON — the static server's ` +
            `SPA fallback answered, which means the file does not exist at that path. ` +
            `A manifest under manifests/ must also be copied to client/public/ to be served.`);
    try {
        return JSON.parse(body);
    } catch (e) {
        throw new Error(`?direct: '${url}' is not valid JSON: ${(e as Error).message}`);
    }
}

/** True when a response body is (the start of) an HTML document. Leading
 *  whitespace and a BOM are tolerated; the check is deliberately narrow so
 *  a JSON document whose first string value mentions `<html>` is unaffected. */
function looksLikeHtml(body: string): boolean {
    const head = body.replace(/^﻿/, '').trimStart().slice(0, 512).toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html');
}
