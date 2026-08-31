import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePendingPurchases } from '../src/api/accounts.js';

const account = { portalId: 2, alias: 'cuenta principal', maskedNumber: '04-72-97-000000-0' };

/**
 * The shape BG returns from `trx-transit`, with invented values. Charges hang
 * two levels down, grouped by the debit card that made them — flattening that
 * is the whole job of the normalizer.
 */
const RAW = {
    '@type': 'AssociatedAccountMovement',
    totalAccountMovement: 46.4,
    associatedCreditCardMovement: [
        {
            card: {
                '@type': 'GenericCard',
                nameCard: 'DOE/JANE',
                cardType: { '@type': 'Catalog', id: '60', description: 'VISA DEBITO' },
                idCard: { maskCardNumber: '**** 1111' },
            },
            totalCardMovement: 46.4,
            movement: [
                {
                    '@type': 'SavingAccountMovementsModel',
                    id: '900000001',
                    // 2026-08-28 23:30 Panama == 2026-08-29 04:30 UTC.
                    dateMovement: Date.UTC(2026, 7, 29, 4, 30, 0),
                    amountMovement: 19.4,
                    commerce: { '@type': 'Commerce', description: 'TIENDA EJEMPLO   PROVINCIA   PA' },
                    authCode: 'AAAAAA',
                },
                {
                    '@type': 'SavingAccountMovementsModel',
                    id: '900000002',
                    dateMovement: Date.UTC(2026, 7, 30, 12, 0, 0),
                    amountMovement: 27,
                    commerce: { '@type': 'Commerce', description: 'OTRO COMERCIO    PROVINCIA   PA' },
                    authCode: 'BBBBBB',
                },
            ],
        },
    ],
};

test('flattens pending purchases out of the per-card grouping', () => {
    const pending = normalizePendingPurchases(RAW, account);

    assert.equal(pending.length, 2);
    assert.deepEqual(
        pending.map((p) => p.id),
        ['900000001', '900000002'],
    );
    assert.equal(pending[0]?.description, 'TIENDA EJEMPLO   PROVINCIA   PA');
    assert.equal(pending[0]?.amount, 19.4);
    assert.equal(pending[0]?.card, '**** 1111');
    assert.equal(pending[0]?.authCode, 'AAAAAA');
    assert.equal(pending[0]?.accountPortalId, 2);
    assert.equal(pending[0]?.account, 'cuenta principal');
});

// `posted: false` means "not booked as a movement yet", not "might not happen".
// The money is already out of the available balance.
test('a pending purchase is always spending, and never posted', () => {
    for (const p of normalizePendingPurchases(RAW, account)) {
        assert.equal(p.type, 'Gasto');
        assert.equal(p.nature, 'D');
        assert.equal(p.source, 'pending');
        assert.equal(p.posted, false);
        assert.equal(p.balanceAfter, null);
    }
});

// Same rule as every other date in this codebase: a late-night charge must not
// drift into the next day, or it lands outside the month the user asked about.
test('dates are Panama-local, not UTC', () => {
    const [first] = normalizePendingPurchases(RAW, account);
    assert.equal(first?.date, '2026-08-28');
});

test('an account with nothing in transit yields no rows', () => {
    assert.deepEqual(normalizePendingPurchases({ totalAccountMovement: 0 }, account), []);
    assert.deepEqual(
        normalizePendingPurchases({ associatedCreditCardMovement: [{ movement: [] }] }, account),
        [],
    );
});

// Never throw on a surprising payload: pending purchases ride along with the
// real answer in several tools, and taking the whole call down over a missing
// field would be worse than reporting nothing pending.
test('tolerates missing levels and null payloads', () => {
    assert.deepEqual(normalizePendingPurchases(null, account), []);
    assert.deepEqual(normalizePendingPurchases(undefined, account), []);
    assert.deepEqual(normalizePendingPurchases({}, account), []);

    const partial = normalizePendingPurchases(
        { associatedCreditCardMovement: [{ movement: [{ id: 5 }] }] },
        account,
    );
    assert.equal(partial.length, 1);
    assert.equal(partial[0]?.id, '5');
    assert.equal(partial[0]?.amount, 0);
    assert.equal(partial[0]?.description, '');
    assert.equal(partial[0]?.card, '');
});
