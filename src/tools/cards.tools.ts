/** Credit-card statements, history and BG's own category breakdown. Plus the pension. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { findAccount } from '../api/accounts.js';
import {
    getAssociatedCards,
    getCategoryTotals,
    getCardStatement,
    getStatementHistory,
} from '../api/cards.js';
import { getPensionState, getPensionStatement } from '../api/pension.js';
import { toLocalDate } from '../api/normalize.js';
import { errorResult, guarded, jsonResult } from './helpers.js';

export function registerCardTools(server: McpServer): void {
    server.registerTool(
        'bg_get_card_statement',
        {
            title: 'Get credit card statement',
            description:
                'Statement for a credit card: balance, minimum payment, cutoff and due dates, credit plans and ' +
                'rates. Pass month/year for a past statement, or omit both for the current period. Also returns ' +
                'the history of past cutoff dates so you can pick another period.',
            inputSchema: {
                portalId: z.number().int().describe('Credit card portalId from bg_list_accounts.'),
                month: z.number().int().min(1).max(12).optional().describe('1-based month.'),
                year: z.number().int().min(2000).max(2100).optional().describe('Four-digit year.'),
            },
        },
        guarded(
            async ({ portalId, month, year }: { portalId: number; month?: number; year?: number }) => {
                const account = await findAccount(portalId);
                if (!account) {
                    return errorResult(`No product with portalId ${portalId}.`, 'ACCOUNT_NOT_FOUND');
                }
                if (account.classType !== 'CreditCard') {
                    return errorResult(`portalId ${portalId} is not a credit card.`, 'WRONG_ACCOUNT_TYPE');
                }

                const [statement, history, cards] = await Promise.all([
                    getCardStatement(portalId, month ?? 0, year ?? 0),
                    getStatementHistory(portalId).catch(() => null),
                    getAssociatedCards(portalId).catch(() => null),
                ]);

                // The history comes back as raw epochs; add readable dates so the
                // model doesn't have to convert them to pick a period.
                const readableHistory = Array.isArray(history)
                    ? history.map((h: Record<string, unknown>) => ({
                          ...h,
                          cutDateLocal: toLocalDate(h['cutDate'] as number),
                          paymentDateLocal: toLocalDate(h['paymentDate'] as number),
                      }))
                    : history;

                return jsonResult({
                    card: { portalId, alias: account.alias, maskedNumber: account.maskedNumber },
                    period: month && year ? `${year}-${String(month).padStart(2, '0')}` : 'current',
                    statement,
                    statementHistory: readableHistory,
                    associatedCards: cards,
                });
            },
        ),
    );

    server.registerTool(
        'bg_get_card_categories',
        {
            title: 'Get credit card spending by category',
            description:
                "Banco General's own spend-by-category breakdown for a card statement period (Comida y Bebida, " +
                'Transporte, Supermercados, etc.), with transaction counts and totals. Omit month/year for the ' +
                'current period. This is the bank\'s categorization, not a computed one.',
            inputSchema: {
                portalId: z.number().int().describe('Credit card portalId from bg_list_accounts.'),
                month: z.number().int().min(1).max(12).optional().describe('1-based month.'),
                year: z.number().int().min(2000).max(2100).optional().describe('Four-digit year.'),
            },
        },
        guarded(
            async ({ portalId, month, year }: { portalId: number; month?: number; year?: number }) => {
                const account = await findAccount(portalId);
                if (!account) {
                    return errorResult(`No product with portalId ${portalId}.`, 'ACCOUNT_NOT_FOUND');
                }
                if (account.classType !== 'CreditCard') {
                    return errorResult(`portalId ${portalId} is not a credit card.`, 'WRONG_ACCOUNT_TYPE');
                }

                const totals = await getCategoryTotals(portalId, month ?? 0, year ?? 0);
                const rows = Array.isArray(totals) ? totals : [];
                const nonZero = rows.filter(
                    (r: Record<string, unknown>) => Number(r['totalAmount'] ?? 0) !== 0,
                );
                return jsonResult({
                    card: { portalId, alias: account.alias },
                    period: month && year ? `${year}-${String(month).padStart(2, '0')}` : 'current',
                    categories: rows,
                    categoriesWithSpend: nonZero.length,
                    grandTotal: round(
                        rows.reduce(
                            (s: number, r: Record<string, unknown>) => s + Number(r['totalAmount'] ?? 0),
                            0,
                        ),
                    ),
                });
            },
        ),
    );

    server.registerTool(
        'bg_get_pension',
        {
            title: 'Get Pro-Futuro pension detail',
            description:
                'Balances and fund breakdown for the Pro-Futuro pension product, plus the monthly statement ' +
                '(contributions, interest, commissions, withdrawals) when month and year are given.',
            inputSchema: {
                portalId: z.number().int().describe('Pension portalId from bg_list_accounts.'),
                month: z.number().int().min(1).max(12).optional().describe('1-based month for the statement.'),
                year: z.number().int().min(2000).max(2100).optional().describe('Four-digit year.'),
            },
        },
        guarded(
            async ({ portalId, month, year }: { portalId: number; month?: number; year?: number }) => {
                const state = await getPensionState(portalId);
                const statement =
                    month !== undefined && year !== undefined
                        ? await getPensionStatement(portalId, month, year).catch(() => null)
                        : null;
                return jsonResult({
                    portalId,
                    state,
                    statementPeriod:
                        month && year ? `${year}-${String(month).padStart(2, '0')}` : null,
                    statement,
                });
            },
        ),
    );
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}
