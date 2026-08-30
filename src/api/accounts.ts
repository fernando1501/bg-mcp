/** Product enumeration and per-account detail. */

import { BASE } from '../config.js';
import { bank } from '../http/client.js';
import { flattenAccounts, type Account } from './normalize.js';

export async function listAccounts(): Promise<Account[]> {
    const groups = await bank.get<Parameters<typeof flattenAccounts>[0]>('/o/api/dashboard/product');
    return flattenAccounts(groups);
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

/** Transactions BG has accepted but not yet posted to the balance. */
export async function getTransitTransactions(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/saving-account/trx-transit/${portalId}`,
        savingsReferer(portalId),
    );
}
