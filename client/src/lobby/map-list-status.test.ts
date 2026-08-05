import { describe, it, expect } from 'vitest';
import { mapListStatus } from './map-list-status';

describe('mapListStatus (D33 regression)', () => {
    it('reports maps normally', () => {
        expect(mapListStatus(7, '')).toEqual({ kind: 'ok' });
    });

    it('reports a genuinely empty install as empty', () => {
        expect(mapListStatus(0, '')).toEqual({ kind: 'empty' });
    });

    it('reports a failed read as an error, NOT as an empty map set', () => {
        // The exact D33 shape: the read failed, so the list is empty — but
        // the cause is a faulted server DB handle, not missing map files.
        const status = mapListStatus(0, 'file is not a database');
        expect(status.kind).toBe('error');
        expect(status).toEqual({ kind: 'error', detail: 'file is not a database' });
    });

    it('lets an error win even if some maps were already cached', () => {
        // A partial read must still surface as a fault rather than quietly
        // presenting a short list as the whole truth.
        expect(mapListStatus(3, 'HTTP 503').kind).toBe('error');
    });
});
