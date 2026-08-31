/** Product enumeration and per-account detail. */

import { BASE } from '../config.js';
import { bank, SessionExpiredError } from '../http/client.js';
import {
    flattenAccounts,
    toLocalDate,
    type Account,
    type PendingPurchase,
} from './normalize.js';

export async function listAccounts(): Promise<Account[]> {
    const groups = await bank.get<unknown>('/o/api/dashboard/product');
    // BG doesn't always answer an unauthenticated request with a redirect: it
    // can return 200 and a payload that simply isn't the product list. That
    // flattens to zero accounts, and a dead session ends up reading as "you
    // have no money" all the way up to the spending summary. Anything that
    // isn't the expected array is a session problem, not an empty portfolio.
    if (!Array.isArray(groups)) {
        throw new SessionExpiredError(
            'Banco General did not return the product list, which means the session is not usable.',
        );
    }
    return flattenAccounts(groups as Parameters<typeof flattenAccounts>[0]);
}

/** Looks up one account in the dashboard listing by its portalId. */
export async function findAccount(portalId: number): Promise<Account | null> {
    const accounts = await listAccounts();
    return accounts.find((a) => a.portalId === portalId) ?? null;
}

export function savingsReferer(portalId: number): string {
    return `${BASE}/group/guest/detalle-de-cuenta-de-ahorro?origin=${portalId}`;
}

export function cardReferer(portalId: number): string {
    return `${BASE}/group/guest/detalle-de-tarjeta-de-credito?origin=${portalId}`;
}

export function pensionReferer(portalId: number): string {
    return `${BASE}/group/guest/detalle-de-profuturo?origin=${portalId}`;
}

/** Full BG detail payload for a savings account (balances, rates, status). */
export async function getSavingsAccountDetail(portalId: number): Promise<unknown> {
    return bank.get(`/o/api/product-info/saving-account/state/${portalId}`, savingsReferer(portalId));
}

/** Debit cards attached to a savings account. */
export async function getAssociatedAccountCards(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/saving-account/associated-account-card/${portalId}`,
        savingsReferer(portalId),
    );
}

/** Charges already taken out of the available balance but not yet posted as movements. */
export async function getTransitTransactions(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/saving-account/trx-transit/${portalId}`,
        savingsReferer(portalId),
    );
}

/**
 * BG's shape for `trx-transit`. Charges are grouped by the debit card that made
 * them, so the movements are two levels down.
 */
interface RawTransitResponse {
    totalAccountMovement?: number;
    associatedCreditCardMovement?: Array<{
        card?: { idCard?: { maskCardNumber?: string } };
        movement?: Array<{
            id?: string | number;
            dateMovement?: number;
            amountMovement?: number;
            commerce?: { description?: string };
            authCode?: string;
        }>;
    }>;
}

/** Flattens `trx-transit` into Transaction-shaped rows the other tools can merge. */
export function normalizePendingPurchases(
    raw: unknown,
    account: { portalId: number; alias: string; maskedNumber: string },
): PendingPurchase[] {
    const response = (raw ?? {}) as RawTransitResponse;
    const out: PendingPurchase[] = [];

    for (const group of response.associatedCreditCardMovement ?? []) {
        const card = group.card?.idCard?.maskCardNumber ?? '';
        for (const movement of group.movement ?? []) {
            out.push({
                id: String(movement.id ?? ''),
                date: toLocalDate(movement.dateMovement),
                timestamp: movement.dateMovement ?? 0,
                account: account.alias || account.maskedNumber,
                accountPortalId: account.portalId,
                description: (movement.commerce?.description ?? '').trim(),
                amount: movement.amountMovement ?? 0,
                // Everything in transit is an authorized purchase, and BG sends
                // no nature field for these — there is nothing to derive it from.
                nature: 'D',
                type: 'Gasto',
                balanceAfter: null,
                source: 'pending',
                posted: false,
                card,
                authCode: movement.authCode ?? '',
            });
        }
    }

    return out;
}

/** Pending purchases for one savings account, normalized. */
export async function getPendingPurchases(account: {
    portalId: number;
    alias: string;
    maskedNumber: string;
}): Promise<PendingPurchase[]> {
    return normalizePendingPurchases(await getTransitTransactions(account.portalId), account);
}
