import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listAccounts } from '../src/api/accounts.js';
import { bank, SessionExpiredError } from '../src/http/client.js';
import { looksAuthenticated, type SessionRecord } from '../src/auth/session.js';

/** Swaps the singleton's `get` for the duration of one case. */
async function withResponse<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
    const client = bank as unknown as { get: (path: string) => Promise<unknown> };
    const original = client.get;
    client.get = async () => payload;
    try {
        return await run();
    } finally {
        client.get = original;
    }
}

// The regression that matters: an unauthenticated read used to flatten into
// zero accounts, so the spending summary reported $0 spent instead of saying
// the user was never logged in.
for (const payload of [null, undefined, {}, '', '<html>login</html>', { error: 'unauthorized' }]) {
    test(`listAccounts refuses to read ${JSON.stringify(payload) ?? 'undefined'} as an empty portfolio`, async () => {
        await withResponse(payload, async () => {
            await assert.rejects(() => listAccounts(), SessionExpiredError);
        });
    });
}

test('listAccounts still allows a genuinely empty product list', async () => {
    await withResponse([], async () => {
        assert.deepEqual(await listAccounts(), []);
    });
});

test('listAccounts flattens a normal product list', async () => {
    const groups = [{ products: [{ name: 'Ahorros', accounts: [{ portalId: 7, name: 'Mi cuenta' }] }] }];
    await withResponse(groups, async () => {
        const accounts = await listAccounts();
        assert.equal(accounts.length, 1);
        assert.equal(accounts[0]?.portalId, 7);
    });
});

// Pins the reason bg_session_status has to hit the network: BG's session cookie
// has no expiry, so this check stays true no matter how stale the file is.
test('looksAuthenticated cannot tell a stale session from a live one', () => {
    const session = {
        username: 'someone',
        loggedInAt: 0,
        lastVerifiedAt: 0,
        remembered: false,
        storageState: {
            cookies: [
                {
                    name: 'JSESSIONID',
                    value: 'x',
                    domain: '.bgeneral.com',
                    path: '/',
                    expires: -1,
                    httpOnly: true,
                    secure: true,
                    sameSite: 'Lax',
                },
            ],
            origins: [],
        },
    } satisfies SessionRecord;

    assert.equal(looksAuthenticated(session), true);
});
