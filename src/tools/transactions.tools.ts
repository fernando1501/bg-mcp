/** Transaction listing for savings accounts. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { findAccount, getTransitTransactions } from '../api/accounts.js';
import { getCardMovements, normalizeCardMovements } from '../api/cards.js';
import { clampToDateRange, parseLocalDate } from '../api/normalize.js';
import { getSavingsMovements, normalizeSavingsMovements } from '../api/savings.js';
import { errorResult, guarded, jsonResult, limited } from './helpers.js';

const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .describe('Date in YYYY-MM-DD, interpreted in Panama local time.');

export function registerTransactionTools(server: McpServer): void {
    server.registerTool(
        'bg_list_transactions',
        {
            title: 'List savings account transactions',
            description:
                'Transactions for one savings account over a date range, with pagination handled internally. ' +
                'Dates are Panama local time. Also returns pending purchases ("Compras en proceso") — accepted ' +
                'but not yet posted, and reported separately because they are in neither the totals nor the ' +
                'balance. For credit-card charges use bg_list_card_transactions instead.',
            inputSchema: {
                portalId: z.number().int().describe('Savings account portalId from bg_list_accounts.'),
                fromDate: isoDate,
                toDate: isoDate,
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe('Cap the number of transactions returned. Omit to return all.'),
                includePending: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        'Include pending purchases ("Compras en proceso"). They have no posting date, so they ' +
                        'are returned in full regardless of the date range.',
                    ),
            },
        },
        guarded(
            async ({
                portalId,
                fromDate,
                toDate,
                limit,
                includePending,
            }: {
                portalId: number;
                fromDate: string;
                toDate: string;
                limit?: number;
                includePending?: boolean;
            }) => {
                if (fromDate > toDate) {
                    return errorResult('fromDate must be on or before toDate.', 'INVALID_RANGE');
                }
                const account = await findAccount(portalId);
                if (!account) {
                    return errorResult(
                        `No product with portalId ${portalId}. Call bg_list_accounts first.`,
                        'ACCOUNT_NOT_FOUND',
                    );
                }
                if (account.classType === 'CreditCard') {
                    return errorResult(
                        `portalId ${portalId} is a credit card. Use bg_list_card_transactions.`,
                        'WRONG_ACCOUNT_TYPE',
                    );
                }

                const raw = await getSavingsMovements(
                    portalId,
                    parseLocalDate(fromDate),
                    parseLocalDate(toDate, true),
                );
                // BG overshoots the requested window by up to a day; trust the
                // Panama-local date and drop anything outside it.
                const all = clampToDateRange(
                    normalizeSavingsMovements(raw, account),
                    fromDate,
                    toDate,
                );
                all.sort((a, b) => a.timestamp - b.timestamp);

                const { items, truncated, total } = limited(all, limit);
                const income = all
                    .filter((t) => t.type === 'Ingreso')
                    .reduce((s, t) => s + t.amount, 0);
                const expense = all
                    .filter((t) => t.type === 'Gasto')
                    .reduce((s, t) => s + t.amount, 0);

                // Kept out of `transactions` and out of `totals` on purpose: a
                // pending charge posts later as a real movement, so folding it
                // in here would count the same purchase twice.
                let pendingPurchases: unknown = undefined;
                let pendingPurchasesError: string | undefined;
                if (includePending !== false) {
                    try {
                        pendingPurchases = await getTransitTransactions(portalId);
                    } catch (err) {
                        pendingPurchasesError = err instanceof Error ? err.message : String(err);
                    }
                }

                return jsonResult({
                    account: { portalId, alias: account.alias, maskedNumber: account.maskedNumber },
                    range: { fromDate, toDate },
                    total,
                    returned: items.length,
                    truncated,
                    totals: {
                        income: round(income),
                        expense: round(expense),
                        net: round(income - expense),
                    },
                    transactions: items,
                    pendingPurchases,
                    pendingPurchasesError,
                    pendingPurchasesNote:
                        'Compras en proceso: accepted by the bank, not yet posted. Not included in totals, in ' +
                        'transactions, or in the account balance.',
                });
            },
        ),
    );

    server.registerTool(
        'bg_list_card_transactions',
        {
            title: 'List credit card transactions',
            description:
                'Charges and payments on a credit card for a statement period. Pass month/year for a specific ' +
                'period, or omit both for the current one. A BG statement period is not a calendar month — it ' +
                'runs from the previous cutoff date — so set clampToMonth to restrict results to the calendar month.',
            inputSchema: {
                portalId: z.number().int().describe('Credit card portalId from bg_list_accounts.'),
                month: z
                    .number()
                    .int()
                    .min(1)
                    .max(12)
                    .optional()
                    .describe('1-based month. Omit (with year) for the current statement period.'),
                year: z.number().int().min(2000).max(2100).optional().describe('Four-digit year.'),
                clampToMonth: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe('Drop transactions outside the given calendar month. Requires month and year.'),
                limit: z.number().int().positive().optional().describe('Cap the number returned.'),
            },
        },
        guarded(
            async ({
                portalId,
                month,
                year,
                clampToMonth,
                limit,
            }: {
                portalId: number;
                month?: number;
                year?: number;
                clampToMonth?: boolean;
                limit?: number;
            }) => {
                const account = await findAccount(portalId);
                if (!account) {
                    return errorResult(
                        `No product with portalId ${portalId}. Call bg_list_accounts first.`,
                        'ACCOUNT_NOT_FOUND',
                    );
                }
                if (account.classType !== 'CreditCard') {
                    return errorResult(
                        `portalId ${portalId} is not a credit card. Use bg_list_transactions.`,
                        'WRONG_ACCOUNT_TYPE',
                    );
                }
                if (clampToMonth && (month === undefined || year === undefined)) {
                    return errorResult('clampToMonth requires both month and year.', 'INVALID_ARGS');
                }

                // BG treats 0/0 as "current statement period".
                const raw = await getCardMovements(portalId, month ?? 0, year ?? 0);
                let all = normalizeCardMovements(raw, account);

                if (clampToMonth && month !== undefined && year !== undefined) {
                    const prefix = `${year}-${String(month).padStart(2, '0')}`;
                    all = all.filter((t) => t.date.startsWith(prefix));
                }
                all.sort((a, b) => a.timestamp - b.timestamp);

                const { items, truncated, total } = limited(all, limit);
                const charges = all.filter((t) => t.nature === 'D').reduce((s, t) => s + t.amount, 0);
                const payments = all.filter((t) => t.nature === 'C').reduce((s, t) => s + t.amount, 0);

                return jsonResult({
                    card: { portalId, alias: account.alias, maskedNumber: account.maskedNumber },
                    period: month && year ? `${year}-${String(month).padStart(2, '0')}` : 'current',
                    clampedToCalendarMonth: clampToMonth ?? false,
                    total,
                    returned: items.length,
                    truncated,
                    totals: { charges: round(charges), payments: round(payments) },
                    transactions: items,
                });
            },
        ),
    );
}

/** Float sums drift; two decimals is the only meaningful precision for money here. */
function round(n: number): number {
    return Math.round(n * 100) / 100;
}
