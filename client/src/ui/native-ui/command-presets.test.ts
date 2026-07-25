import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    configureCommandPresets, listCommandPresets, saveCommandPreset, deleteCommandPreset,
} from './command-presets.js';
import type { CommandIntent } from './compile-table.js';

const intent: CommandIntent = {
    verb: 'attack',
    subject: { type: 'group', groupId: 3 },
    target: { shape: 'point', point: { x: 100, z: 200 } },
    priority: 75,
};

describe('command-presets', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        configureCommandPresets({ endpoint: 'http://lobby.test', token: 'tok' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('lists presets from the server, mapping the wire shape to CommandPreset', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                presets: [{ name: 'Assault North Basin', intent, updated_at: '2026-07-25T00:00:00Z' }],
            }),
        });

        const presets = await listCommandPresets();
        expect(fetchMock).toHaveBeenCalledWith('http://lobby.test/api/presets/list', expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
        }));
        expect(presets).toEqual([{ name: 'Assault North Basin', intent, updatedAt: '2026-07-25T00:00:00Z' }]);
    });

    it('returns an empty list on a server error rather than throwing', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401 });
        expect(await listCommandPresets()).toEqual([]);
    });

    it('returns an empty list on a network failure rather than throwing', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        expect(await listCommandPresets()).toEqual([]);
    });

    it('saves a preset, sending the name and intent as-is', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const error = await saveCommandPreset('Assault North Basin', intent);
        expect(error).toBeNull();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://lobby.test/api/presets/save');
        expect(JSON.parse(init.body)).toEqual({ name: 'Assault North Basin', intent });
    });

    it('surfaces the server error message on a failed save', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({ error: 'preset limit reached' }) });
        const error = await saveCommandPreset('one too many', intent);
        expect(error).toBe('preset limit reached');
    });

    it('deletes a preset by name', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
        const deleted = await deleteCommandPreset('Assault North Basin');
        expect(deleted).toBe(true);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://lobby.test/api/presets/delete');
        expect(JSON.parse(init.body)).toEqual({ name: 'Assault North Basin' });
    });

    it('reports delete failure without throwing', async () => {
        fetchMock.mockRejectedValue(new Error('offline'));
        expect(await deleteCommandPreset('x')).toBe(false);
    });
});
