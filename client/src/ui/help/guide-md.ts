/**
 * guide-md.ts — the pure half of the help drawer: a deliberately tiny
 * Markdown subset (headings, paragraphs, bullet lists, tables, bold, italic,
 * code) sufficient for docs/player-guide.md. Not a Markdown engine; anything
 * the guide does not use is rendered as text.
 */

export function slugify(heading: string): string {
    return heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// Inline marks, applied after escaping so the guide can never inject markup.
export function inline(text: string): string {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/—/g, '&mdash;');
}

/// Section = one `##` heading and its body; the drawer scrolls to `id`.
export interface GuideSection { id: string; title: string }

export function renderGuide(md: string): { html: string; sections: GuideSection[] } {
    const out: string[] = [];
    const sections: GuideSection[] = [];
    const lines = md.split('\n');
    let para: string[] = [];
    let list: string[] = [];
    let table: string[][] = [];
    const flush = () => {
        if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
        if (list.length) { out.push(`<ul>${list.map(l => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; }
        if (table.length) {
            const [head, ...rows] = table;
            out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('')
                + '</tr></thead><tbody>'
                + rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
                + '</tbody></table>');
            table = [];
        }
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const h = /^(#{1,3})\s+(.*)$/.exec(line);
        if (h) {
            flush();
            const level = h[1].length;
            const title = h[2].trim();
            const id = slugify(title);
            if (level === 2) sections.push({ id, title });
            out.push(`<h${level} id="help-${id}">${inline(title)}</h${level}>`);
            continue;
        }
        if (line.startsWith('|')) {
            const cells = line.split('|').slice(1, -1).map(c => c.trim());
            if (cells.every(c => /^-+$/.test(c))) continue;
            if (para.length || list.length) flush();
            table.push(cells);
            continue;
        }
        const li = /^[-*]\s+(.*)$/.exec(line);
        if (li) {
            if (para.length || table.length) flush();
            list.push(li[1]);
            continue;
        }
        if (line === '') { flush(); continue; }
        if (list.length && /^\s{2,}/.test(raw)) { list[list.length - 1] += ' ' + line.trim(); continue; }
        if (list.length || table.length) flush();
        para.push(line.trim());
    }
    flush();
    return { html: out.join('\n'), sections };
}

/// `openHelp('standing')` → the section whose slug or title contains the
/// topic; null when there is no such section (the drawer opens at the top).
export function findSection(sections: GuideSection[], topic: string | undefined): GuideSection | null {
    if (!topic) return null;
    const t = slugify(topic);
    return sections.find(s => s.id === t)
        ?? sections.find(s => s.id.includes(t) || t.includes(s.id))
        ?? null;
}
