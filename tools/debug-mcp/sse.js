// sse.js — a minimal, incremental Server-Sent-Events parser.
//
// The lobby pushes world notifications over the per-account chat SSE channel
// (`/api/chat/stream`) as named `world-staging` events; there is no REST
// route for them. `world_notifications` opens that stream for a bounded
// window and needs to turn the byte chunks into events. Pure, no I/O.

export class SseParser {
    constructor() { this.buf = ''; this.cur = { event: 'message', data: [], id: null }; }

    /** Feed a chunk; returns the events completed by it. */
    push(chunk) {
        this.buf += String(chunk).replace(/\r\n?/g, '\n');
        const out = [];
        let nl;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 1);
            if (line === '') {
                if (this.cur.data.length) {
                    out.push({ event: this.cur.event, data: this.cur.data.join('\n'), id: this.cur.id });
                }
                this.cur = { event: 'message', data: [], id: null };
                continue;
            }
            if (line.startsWith(':')) continue;                 // comment / keepalive
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'event') this.cur.event = value || 'message';
            else if (field === 'data') this.cur.data.push(value);
            else if (field === 'id') this.cur.id = value;
        }
        return out;
    }
}

/** Convenience: parse a whole text. */
export function parseSse(text) {
    const p = new SseParser();
    return p.push(String(text) + '\n\n');
}
