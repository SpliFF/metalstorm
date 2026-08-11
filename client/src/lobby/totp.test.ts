import { describe, it, expect } from 'vitest';
import {
    classifyLoginResponse,
    normaliseCode,
    looksLikeTotpCode,
    formatSecret,
    describeStatus,
} from './totp';

// PLAN-metalstorm-lobby.md §7.2, task 8d — the client's half of the second
// factor. The one non-obvious decision is what a 401 MEANS now, and that is
// where all the failure modes live.

describe('classifyLoginResponse', () => {
    it('passes a successful login through', () => {
        const out = classifyLoginResponse({ ok: true, status: 200 },
            { token: 'abc', user_id: 3 }, false);
        expect(out.kind).toBe('ok');
    });

    it('does not treat a two-factor challenge as a registration', () => {
        // The bug this exists to prevent: `doLogin` has always read "login
        // failed + a confirm-password was typed" as "register this new
        // account". A 2FA challenge is a failed login too — so a player with
        // 2FA on who happens to fill the confirm field would have their
        // challenge answered with `409 username already taken`, about their
        // own account.
        const out = classifyLoginResponse({ ok: false, status: 401 },
            { error: 'two-factor code required', totp_required: true },
            /*canRegister=*/true);
        expect(out.kind).toBe('totp-required');
    });

    it('keeps the challenge on a wrong code, rather than falling back', () => {
        // The retry carries the same flag. Classifying the second failure as
        // anything else would drop the player back to the password form and
        // lose the code field mid-login.
        const out = classifyLoginResponse({ ok: false, status: 401 },
            { error: 'invalid two-factor code', totp_required: true }, false);
        expect(out.kind).toBe('totp-required');
        expect(out.kind === 'totp-required' && out.message)
            .toBe('invalid two-factor code');
    });

    it('registers only when the caller offered a confirm-password', () => {
        expect(classifyLoginResponse({ ok: false, status: 401 },
            { error: 'invalid credentials' }, true).kind).toBe('register');
        expect(classifyLoginResponse({ ok: false, status: 401 },
            { error: 'invalid credentials' }, false).kind).toBe('failed');
    });

    it('reports the server wording for an ordinary failure', () => {
        const out = classifyLoginResponse({ ok: false, status: 403 },
            { error: 'account banned' }, false);
        expect(out).toEqual({ kind: 'failed', message: 'account banned' });
    });

    it('treats a 200 with no token as a failure, not a success', () => {
        // Defensive, and load-bearing: `kind: 'ok'` is what makes the caller
        // store credentials, and storing `undefined` as the access token is
        // how a client ends up sending "Bearer undefined" to every route.
        expect(classifyLoginResponse({ ok: true, status: 200 }, {}, false).kind)
            .toBe('failed');
        expect(classifyLoginResponse({ ok: true, status: 200 }, null, false).kind)
            .toBe('failed');
    });
});

describe('code and secret formatting', () => {
    it('strips whatever a player types around a code', () => {
        expect(normaliseCode(' 123 456 ')).toBe('123456');
        expect(normaliseCode('abcde-fghij')).toBe('ABCDEFGHIJ');
    });

    it('tells a 6-digit code from a recovery code', () => {
        expect(looksLikeTotpCode('123 456')).toBe(true);
        expect(looksLikeTotpCode('12345')).toBe(false);
        expect(looksLikeTotpCode('ABCDE-FGHIJ')).toBe(false);
    });

    it('groups a secret for manual entry', () => {
        expect(formatSecret('GEZDGNBVGY3TQOJQ')).toBe('GEZD GNBV GY3T QOJQ');
        expect(formatSecret('')).toBe('');
    });
});

describe('describeStatus', () => {
    it('separates off, pending and on', () => {
        expect(describeStatus({ enabled: false, pending: false, recovery_remaining: 0 }))
            .toMatch(/is off/);
        expect(describeStatus({ enabled: false, pending: true, recovery_remaining: 0 }))
            .toMatch(/not confirmed/);
        expect(describeStatus({ enabled: true, pending: false, recovery_remaining: 10 }))
            .toMatch(/10 recovery codes left/);
    });

    it('says so when the recovery codes are gone', () => {
        // The state that is easy to leave out of a status line and is the one
        // that actually costs an account: 2FA on with nothing to fall back to.
        expect(describeStatus({ enabled: true, pending: false, recovery_remaining: 0 }))
            .toMatch(/No recovery codes left/);
        expect(describeStatus({ enabled: true, pending: false, recovery_remaining: 1 }))
            .toMatch(/1 recovery code left/);
    });
});
