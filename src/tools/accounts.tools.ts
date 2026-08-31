/** Account listing and detail. */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
    findAccount,
    getAssociatedAccountCards,
    getPendingPurchases,
    getSavingsAccountDetail,
    listAccounts,
} from '../api/accounts.js';
import { getCardState } from '../api/cards.js';
import { getPensionState } from '../api/pension.js';
import { errorResult, guarded, jsonResult } from './helpers.js';

export function registerAccountTools(server: McpServer): void {
    server.registerTool(
        'bg_list_accounts',
        {
            title: 'List all accounts and products',
            description:
                'Lists every Banco General product on the dashboard — savings accounts, credit cards and the ' +
                'Pro-Futuro pension — with balances and the portalId other tools need. Start here. ' +
                'Balances are as of BG\'s lastSyncDate, not live.',
            inputSchema: {},
        },
        guarded(async () => {
            const accounts = await listAccounts();
            return jsonResult({
                count: accounts.length,
                accounts,
                note: 'Use portalId to reference an account in the other bg_* tools.',
            });
        }),
    );

    server.registerTool(
        'bg_get_account',
        {
            title: 'Get account detail',
            description:
                'Full detail for one product, dispatching on its type: savings accounts return balances, ' +
                'associated debit cards and pending purchases ("Compras en proceso"), credit cards return ' +
                'limit/cutoff/payment dates, and the pension returns fund balances. ' +
                'Get the portalId from bg_list_accounts.',
            inputSchema: {
                portalId: z.number().int().describe('The account portalId from bg_list_accounts.'),
                includeTransit: z
                    .boolean()
                    .optional()
                    .default(true)
                    .describe(
                        'Savings only: include pending purchases — charges the bank has accepted but not yet ' +
                        'posted to the balance. This is the "Compras en proceso" section of the BG web app. ' +
                        'On by default; they are part of the normal view of an account.',
                    ),
            },
        },
        guarded(async ({ portalId, includeTransit }: { portalId: number; includeTransit?: boolean }) => {
            const account = await findAccount(portalId);
            if (!account) {
                return errorResult(
                    `No product with portalId ${portalId}. Call bg_list_accounts to see valid ids.`,
                    'ACCOUNT_NOT_FOUND',
                );
            }

            if (account.classType === 'CreditCard') {
                return jsonResult({ account, detail: await getCardState(portalId) });
            }
            if (account.classType === 'BGProfuture' || account.productType?.includes('profuture')) {
                return jsonResult({ account, detail: await getPensionState(portalId) });
            }

            const [detail, cards] = await Promise.all([
                getSavingsAccountDetail(portalId),
                getAssociatedAccountCards(portalId).catch(() => null),
            ]);

            // A failed fetch and "nothing pending" are not the same answer, and
            // collapsing them into null is how a pending charge silently goes
            // missing. Report the failure instead of swallowing it, but don't
            // let it take the whole account detail down.
            let pendingPurchases: unknown = undefined;
            let pendingPurchasesError: string | undefined;
            if (includeTransit !== false) {
                try {
                    pendingPurchases = await getPendingPurchases(account);
                } catch (err) {
                    pendingPurchasesError = err instanceof Error ? err.message : String(err);
                }
            }

            return jsonResult({
                account,
                detail,
                associatedCards: cards,
                // "Compras en proceso" in the BG web app: accepted, not yet
                // posted. Already out of the available balance, not yet a movement.
                pendingPurchases,
                pendingPurchasesError,
            });
        }),
    );
}
