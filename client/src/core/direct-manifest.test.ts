import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDirectManifest } from './direct-manifest.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const MANIFEST_DIR = join(REPO_ROOT, 'manifests');
const SERVED_DIR = join(REPO_ROOT, 'client', 'public');

describe('parseDirectManifest', () => {
    it('parses a well-formed manifest', () => {
        const m = parseDirectManifest('x.json', '{"map":"green_flat_x34_v3"}') as any;
        expect(m.map).toBe('green_flat_x34_v3');
    });

    it('names the SPA fallback when the server answers with index.html', () => {
        const html = '<!doctype html>\n<html lang="en">\n  <head>\n</head></html>';
        expect(() => parseDirectManifest('missing.json', html))
            .toThrow(/SPA fallback|does not exist at that path/);
        // and it must point at the actual fix, not just report bad JSON
        expect(() => parseDirectManifest('missing.json', html)).toThrow(/client\/public/);
    });

    it('tolerates leading whitespace and a BOM before the doctype', () => {
        expect(() => parseDirectManifest('missing.json', '﻿\n  <html><body/></html>'))
            .toThrow(/SPA fallback/);
    });

    it('reports malformed JSON as malformed JSON, not as a missing file', () => {
        expect(() => parseDirectManifest('bad.json', '{"map": }')).toThrow(/not valid JSON/);
        expect(() => parseDirectManifest('bad.json', '{"map": }')).not.toThrow(/SPA fallback/);
    });

    it('does not mistake a manifest that merely mentions HTML for a fallback page', () => {
        const m = parseDirectManifest('x.json', '{"comment":"<!doctype html> in a string"}') as any;
        expect(m.comment).toContain('doctype');
    });
});

// `?direct=` fetches from the *served* directory, so a manifest that lives
// only in manifests/ comes back as the SPA fallback (see above). This guard
// is the cheap half of that lesson: PLAN-maps M8b finding 4, which bit again
// on techno_lands_verify_solo.json in M8h.
describe('direct manifests are served', () => {
    const names = readdirSync(MANIFEST_DIR).filter(f => f.endsWith('.json'));

    it('finds manifests to check', () => {
        expect(names.length).toBeGreaterThan(0);
    });

    it.each(names)('%s has an identical copy in client/public/', (name) => {
        const src = readFileSync(join(MANIFEST_DIR, name), 'utf8');
        let served: string;
        try {
            served = readFileSync(join(SERVED_DIR, name), 'utf8');
        } catch {
            throw new Error(
                `manifests/${name} has no client/public/${name} — ?direct=${name} would ` +
                `SPA-fall-back to index.html. Copy it: cp manifests/${name} client/public/`);
        }
        expect(served).toBe(src);
    });

    it('every served manifest names a map', () => {
        for (const name of names) {
            const m = JSON.parse(readFileSync(join(SERVED_DIR, name), 'utf8'));
            expect(m.map, `${name} declares no map`).toBeTruthy();
        }
    });
});
