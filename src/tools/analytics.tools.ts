/**
 * Cross-account analytics.
 *
 * These are the two tools that do work the model would otherwise have to do by
 * hand across many calls: gathering every account's movements for a window and
 * reducing them. Both fan out over accounts and merge the results.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { listAccounts } from '../api/accounts.js';
import { getCardMovements, normalizeCardMovements } from '../api/cards.js';
import {
    clampToDateRange,
    monthRange,
    parseLocalDate,
    type Account,
    type Transaction,
} from '../api/normalize.js';
import { getSavingsMovements, normalizeSavingsMovements } from '../api/savings.js';
import { guarded, jsonResult, limited } from './helpers.js';

/**
 * Collects transactions from every savings account and credit card over a date
 * range. Failures on one product don't sink the whole call — a closed card
 * shouldn't make a spending summary impossible — so they're reported instead.
 */
async function collectAll(
    fromDate: string,
    toDate: string,
): Promise<{ transactions: Transaction[]; accounts: Account[]; errors: string[] }> {
    const accounts = await listAccounts();
    const errors: string[] = [];
    const transactions: Transaction[] = [];

    const savings = accounts.filter((a) => a.classType === 'SavingsAccount');
    const cards = accounts.filter((a) => a.classType === 'CreditCard');

    const start = parseLocalDate(fromDate);
    const end = parseLocalDate(toDate, true);

    for (const account of savings) {
        try {
            const raw = await getSavingsMovements(account.portalId, start, end);
            transactions.push(...normalizeSavingsMovements(raw, account));
        } catch (err) {
            errors.push(`${account.alias}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Card statements are addressed by period, not date range, so pull every
    // period the range touches and let the date clamp sort it out.
    for (const card of cards) {
        for (const { month, year } of monthsBetween(fromDate, toDate)) {
            try {
                const raw = await getCardMovements(card.portalId, month, year);
                transactions.push(...normalizeCardMovements(raw, card));
            } catch (err) {
                errors.push(
                    `${card.alias} ${year}-${month}: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    // Dedup: card statement periods overlap, so the same charge can arrive twice.
    const seen = new Set<string>();
    const deduped = transactions.filter((t) => {
        const key = `${t.source}#${t.accountPortalId}#${t.id}#${t.timestamp}#${t.amount}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return { transactions: clampToDateRange(deduped, fromDate, toDate), accounts, errors };
}

function monthsBetween(fromDate: string, toDate: string): Array<{ month: number; year: number }> {
    const out: Array<{ month: number; year: number }> = [];
    const [fy, fm] = fromDate.split('-').map(Number);
    const [ty, tm] = toDate.split('-').map(Number);
    let year = fy ?? 1970;
    let month = fm ?? 1;
    // A charge posted late can land in the following statement, so include one
    // extra period past the end of the range.
    const lastYear = ty ?? year;
    const lastMonth = (tm ?? month) + 1;
    while (year * 12 + month <= lastYear * 12 + lastMonth) {
        out.push({ month, year });
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
        if (out.length > 24) break; // Guard against an absurd range.
    }
    return out;
}

export function registerAnalyticsTools(server: McpServer): void {
    server.registerTool(
        'bg_search_transactions',
        {
            title: 'Search transactions across all accounts',
            description:
                'Searches every savings account and credit card at once over a date range, optionally filtering ' +
                'by description text and amount. Use this for questions like "how much did I spend at X" or ' +
                '"find that $250 charge in March" — it saves calling the per-account tools one by one.',
            inputSchema: {
                fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date, YYYY-MM-DD (Panama time).'),
                toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date, YYYY-MM-DD (Panama time).'),
                query: z
                    .string()
                    .optional()
                    .describe('Case-insensitive substring matched against the transaction description.'),
                minAmount: z.number().optional().describe('Only transactions of at least this amount.'),
                maxAmount: z.number().optional().describe('Only transactions of at most this amount.'),
                type: z
                    .enum(['Ingreso', 'Gasto'])
                    .optional()
                    .describe('Restrict to income (Ingreso) or spending (Gasto).'),
                limit: z.number().int().positive().optional().default(100).describe('Cap results.'),
            },
        },
        guarded(
            async ({
                fromDate,
                toDate,
                query,
                minAmount,
                maxAmount,
                type,
                limit,
            }: {
                fromDate: string;
                toDate: string;
                query?: string;
                minAmount?: number;
                maxAmount?: number;
                type?: 'Ingreso' | 'Gasto';
                limit?: number;
            }) => {
                const { transactions, errors } = await collectAll(fromDate, toDate);
                const needle = query?.toLowerCase();

                const matched = transactions.filter((t) => {
                    if (needle && !t.description.toLowerCase().includes(needle)) return false;
                    if (minAmount !== undefined && t.amount < minAmount) return false;
                    if (maxAmount !== undefined && t.amount > maxAmount) return false;
                    if (type && t.type !== type) return false;
                    return true;
                });
                matched.sort((a, b) => a.timestamp - b.timestamp);

                const { items, truncated, total } = limited(matched, limit);
                return jsonResult({
                    range: { fromDate, toDate },
                    filters: { query, minAmount, maxAmount, type },
                    total,
                    returned: items.length,
                    truncated,
                    matchedTotal: round(matched.reduce((s, t) => s + t.amount, 0)),
                    transactions: items,
                    ...(errors.length ? { partialFailures: errors } : {}),
                });
            },
        ),
    );

    server.registerTool(
        'bg_spending_summary',
        {
            title: 'Summarize income and spending for a period',
            description:
                'Aggregates every account for a month (or an explicit date range): total income, total spending, ' +
                'net, a per-account breakdown and the largest transactions. Use this for "how did I do this month".',
            inputSchema: {
                month: z
                    .string()
                    .regex(/^\d{4}-\d{2}$/)
                    .optional()
                    .describe('Target month as YYYY-MM. Defaults to the current month if no range is given.'),
                fromDate: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Explicit start date; overrides month.'),
                toDate: z
                    .string()
                    .regex(/^\d{4}-\d{2}-\d{2}$/)
                    .optional()
                    .describe('Explicit end date; overrides month.'),
                topN: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .default(10)
                    .describe('How many largest transactions to include.'),
            },
        },
        guarded(
            async ({
                month,
                fromDate,
                toDate,
                topN,
            }: {
                month?: string;
                fromDate?: string;
                toDate?: string;
                topN?: number;
            }) => {
                let from = fromDate;
                let to = toDate;
                if (!from || !to) {
                    const target = month ?? new Date().toISOString().slice(0, 7);
                    const [y, m] = target.split('-').map(Number);
                    const { start, end } = monthRange(y ?? 1970, (m ?? 1) - 1);
                    // monthRange returns UTC instants; render them back as the
                    // Panama-local calendar days they represent.
                    from = from ?? isoLocal(start);
                    to = to ?? isoLocal(end);
                }

                const { transactions, accounts, errors } = await collectAll(from, to);

                const income = transactions.filter((t) => t.type === 'Ingreso');
                const expense = transactions.filter((t) => t.type === 'Gasto');
                const incomeTotal = income.reduce((s, t) => s + t.amount, 0);
                const expenseTotal = expense.reduce((s, t) => s + t.amount, 0);

                const byAccount: Record<string, { income: number; expense: number; count: number }> = {};
                for (const t of transactions) {
                    const key = t.account;
                    const row = (byAccount[key] ??= { income: 0, expense: 0, count: 0 });
                    row.count += 1;
                    if (t.type === 'Ingreso') row.income = round(row.income + t.amount);
                    else if (t.type === 'Gasto') row.expense = round(row.expense + t.amount);
                }

                const largest = [...expense].sort((a, b) => b.amount - a.amount).slice(0, topN ?? 10);

                return jsonResult({
                    range: { fromDate: from, toDate: to },
                    transactionCount: transactions.length,
                    totals: {
                        income: round(incomeTotal),
                        expense: round(expenseTotal),
                        net: round(incomeTotal - expenseTotal),
                    },
                    byAccount,
                    largestExpenses: largest,
                    accountsScanned: accounts.map((a) => ({
                        portalId: a.portalId,
                        alias: a.alias,
                        classType: a.classType,
                        currentBalance: a.currentBalance,
                    })),
                    note:
                        'Transfers between the user\'s own accounts appear on both sides and are NOT excluded — ' +
                        'inspect descriptions (e.g. "ENTRE CUENTAS") before treating these totals as net cash flow.',
                    ...(errors.length ? { partialFailures: errors } : {}),
                });
            },
        ),
    );
}

/** Renders a UTC instant as the Panama-local calendar day it falls on. */
function isoLocal(d: Date): string {
    return new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}
