import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    clampToDateRange,
    flattenAccounts,
    monthRange,
    natureToType,
    parseLocalDate,
    toLocalDate,
    type Transaction,
} from '../src/api/normalize.js';

test('renders timestamps as Panama-local dates', () => {
    // 2026-07-31 23:30 Panama == 2026-08-01 04:30 UTC. Naive UTC formatting
    // would move this transaction into August.
    const lateNightPanama = Date.UTC(2026, 7, 1, 4, 30, 0);
    assert.equal(toLocalDate(lateNightPanama), '2026-07-31');

    // 2026-07-01 00:30 Panama == 2026-07-01 05:30 UTC.
    assert.equal(toLocalDate(Date.UTC(2026, 6, 1, 5, 30, 0)), '2026-07-01');
});

test('toLocalDate is empty for missing timestamps', () => {
    assert.equal(toLocalDate(null), '');
    assert.equal(toLocalDate(undefined), '');
    assert.equal(toLocalDate(0), '');
});

test('monthRange covers a full Panama calendar month', () => {
    const { start, end } = monthRange(2026, 6); // July 2026
    assert.equal(start.toISOString(), '2026-07-01T05:00:00.000Z');
    assert.equal(end.toISOString(), '2026-08-01T04:59:59.000Z');
    // Both bounds render as days inside the target month.
    assert.equal(toLocalDate(start.getTime()), '2026-07-01');
    assert.equal(toLocalDate(end.getTime()), '2026-07-31');
});

test('monthRange rolls over the year boundary', () => {
    const { start, end } = monthRange(2026, 11); // December 2026
    assert.equal(toLocalDate(start.getTime()), '2026-12-01');
    assert.equal(toLocalDate(end.getTime()), '2026-12-31');
});

test('parseLocalDate brackets a Panama day', () => {
    assert.equal(parseLocalDate('2026-07-15').toISOString(), '2026-07-15T05:00:00.000Z');
    assert.equal(parseLocalDate('2026-07-15', true).toISOString(), '2026-07-16T04:59:59.000Z');
});

test('maps BG movement nature to a transaction type', () => {
    assert.equal(natureToType('C'), 'Ingreso');
    assert.equal(natureToType('D'), 'Gasto');
    assert.equal(natureToType(undefined), '');
    assert.equal(natureToType('X'), '');
});

function tx(date: string): Transaction {
    return {
        id: date,
        date,
        timestamp: 0,
        account: 'test',
        accountPortalId: 0,
        description: '',
        amount: 0,
        nature: 'D',
        type: 'Gasto',
        balanceAfter: null,
        source: 'savings',
    };
}

test('clampToDateRange drops BG overshoot on both ends', () => {
    // BG's savings find overshoots by a day; credit-card find returns the whole
    // statement period, which starts before the calendar month.
    const input = ['2026-06-28', '2026-07-01', '2026-07-15', '2026-07-31', '2026-08-01'].map(tx);
    const kept = clampToDateRange(input, '2026-07-01', '2026-07-31').map((t) => t.date);
    assert.deepEqual(kept, ['2026-07-01', '2026-07-15', '2026-07-31']);
});

test('flattenAccounts walks group → product → accounts', () => {
    const accounts = flattenAccounts([
        {
            products: [
                {
                    name: 'product-deposit-account',
                    accounts: [
                        {
                            portalId: 0,
                            classType: 'SavingsAccount',
                            name: 'yappy',
                            maskedNumber: '04-72-00-560608-0',
                            currentBalance: 4.59,
                            availableBalance: 4.59,
                            lastSyncDate: Date.UTC(2026, 6, 1, 5, 0, 0),
                        },
                    ],
                },
            ],
        },
        {
            products: [
                {
                    name: 'product-credit-card',
                    accounts: [{ portalId: 3, classType: 'CreditCard', alias: 'VISA', maskedNumber: '**** 4730' }],
                },
            ],
        },
    ]);

    assert.equal(accounts.length, 2);
    assert.equal(accounts[0]?.alias, 'yappy');
    assert.equal(accounts[0]?.lastSyncDateLocal, '2026-07-01');
    assert.equal(accounts[1]?.portalId, 3);
    assert.equal(accounts[1]?.classType, 'CreditCard');
    // Missing balances become null rather than 0, so callers don't read an
    // absent balance as "no money".
    assert.equal(accounts[1]?.currentBalance, null);
});

test('flattenAccounts tolerates empty and missing levels', () => {
    assert.deepEqual(flattenAccounts(null), []);
    assert.deepEqual(flattenAccounts([]), []);
    assert.deepEqual(flattenAccounts([{}]), []);
    assert.deepEqual(flattenAccounts([{ products: [{}] }]), []);
});

test('flattenAccounts falls back to sequence when portalId is absent', () => {
    const accounts = flattenAccounts([
        { products: [{ accounts: [{ sequence: 7, classType: 'SavingsAccount' }] }] },
    ]);
    assert.equal(accounts[0]?.portalId, 7);
});
