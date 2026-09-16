import { describe, it, expect } from 'vitest';
import { decideEntry, nicknameNote, soloBootRoute, type AccountMe } from './entry-flow';

const me = (over: Partial<AccountMe> = {}): AccountMe => ({
    user_id: 1, username: 'raven', callsign: 'raven', faction: 'compact', is_provisional: false,
    standing: 0, sessions_played: 0, tier: 0, tier_name: 'Recruit', commander_kind: null,
    intro_done: 0, ...over,
});
const base = { me: null, justRegistered: false, introSeenLocally: false, watch: false };

describe('decideEntry', () => {
    it('sends a watcher to the Mission list regardless of account state', () => {
        expect(decideEntry({ ...base, watch: true, me: me() })).toBe('browser');
    });
    it('shows the intro once, then the hub until tier 1, then the browser', () => {
        expect(decideEntry({ ...base, me: me() })).toBe('intro');
        expect(decideEntry({ ...base, me: me({ intro_done: false }) })).toBe('intro');
        expect(decideEntry({ ...base, me: me({ intro_done: true }) })).toBe('hub');
        expect(decideEntry({ ...base, me: me({ intro_done: 1 }) })).toBe('hub');
        expect(decideEntry({ ...base, me: me({ intro_done: 1, tier: 1 }) })).toBe('browser');
        // A guest is never walked through the intro — it is the sign-up reward.
        expect(decideEntry({ ...base, me: me({ is_provisional: true }) })).toBe('hub');
    });
    it('without the account route, a fresh sign-up sees the intro once and everyone else the hub', () => {
        expect(decideEntry({ ...base, justRegistered: true })).toBe('intro');
        expect(decideEntry({ ...base, justRegistered: true, introSeenLocally: true })).toBe('hub');
        expect(decideEntry(base)).toBe('hub');
    });
});

describe('soloBootRoute', () => {
    it('uses the dev direct route only on the lobby host', () => {
        expect(soloBootRoute('localhost')).toBe('direct');
        expect(soloBootRoute('127.0.0.1')).toBe('direct');
        expect(soloBootRoute('play.example.org')).toBe('solo');
    });
});

describe('nicknameNote', () => {
    it('says so when the server ignored the callsign', () => {
        expect(nicknameNote('raven', 'raven')).toBe('');
        expect(nicknameNote('raven', 'guest-0badf00d')).toMatch(/guest-0badf00d/);
    });
});
