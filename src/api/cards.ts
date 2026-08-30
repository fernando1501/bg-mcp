/**
 * Credit-card state, movements and category totals.
 *
 * Note the month/year semantics: `find` and `state-card` take a 1-based month,
 * and `{ month: 0, year: 0 }` means "current statement period". A statement
 * period is not a calendar month — it starts on the previous cutoff date — so
 * callers that want a calendar month must clamp the results by date.
 */

import { bank } from '../http/client.js';
import { cardReferer } from './accounts.js';
import { natureToType, toLocalDate, type Transaction } from './normalize.js';

interface RawCardMovement {
    id?: string;
    dateMovement?: number;
    effectiveDate?: number;
    natureMovement?: string;
    amountMovement?: number;
    description?: string;
    _cardLabel?: string;
}

interface CardFindResponse {
    associatedCreditCardMovement?: Array<{
        card?: { idCard?: { maskCardNumber?: string }; nameCard?: string };
        movement?: RawCardMovement[];
    }>;
}

/** Current balance, limit, cutoff and payment dates for a card. */
export async function getCardState(portalId: number): Promise<unknown> {
    return bank.post('/o/api/product-info/credit-card/state', portalId, cardReferer(portalId));
}

/** Statement detail for one period (1-based month; 0/0 = current period). */
export async function getCardStatement(
    portalId: number,
    month: number,
    year: number,
): Promise<unknown> {
    return bank.post(
        '/o/api/product-info/credit-card/state-card',
        { productId: String(portalId), productType: null, month, year },
        cardReferer(portalId),
    );
}

/** Past statement cutoff dates and balances — useful for picking a period. */
export async function getStatementHistory(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/credit-card/credit-card-statement-history/${portalId}`,
        cardReferer(portalId),
    );
}

/** Physical/virtual cards sharing the account. */
export async function getAssociatedCards(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/credit-card/associated-credit-card/${portalId}`,
        cardReferer(portalId),
    );
}

/** BG's own spend-by-category breakdown for a period. */
export async function getCategoryTotals(
    portalId: number,
    month: number,
    year: number,
): Promise<unknown> {
    return bank.post(
        '/o/api/product-info/credit-card/credit-card-categories-totals',
        { productId: String(portalId), posNumber: -1, id: null, month, year },
        cardReferer(portalId),
    );
}

export async function getCategoryCatalog(portalId: number): Promise<unknown> {
    return bank.post(
        '/o/api/product-info/credit-card/get-categories-catalog',
        {},
        cardReferer(portalId),
    );
}

/**
 * Movements for a statement period, flattened across sub-cards (each
 * cardholder gets their own `movement[]` array).
 */
export async function getCardMovements(
    portalId: number,
    month: number,
    year: number,
): Promise<RawCardMovement[]> {
    const res = await bank.post<CardFindResponse>(
        '/o/api/product-info/credit-card/find',
        { productId: String(portalId), month, year },
        cardReferer(portalId),
    );
    const all: RawCardMovement[] = [];
    for (const group of res?.associatedCreditCardMovement ?? []) {
        const label = group?.card?.idCard?.maskCardNumber ?? group?.card?.nameCard ?? '';
        for (const m of group?.movement ?? []) {
            all.push({ ...m, _cardLabel: label });
        }
    }
    return all;
}

export function normalizeCardMovements(
    movements: RawCardMovement[],
    account: { portalId: number; alias: string; maskedNumber: string },
): Transaction[] {
    return movements.map((m) => {
        const timestamp = m.dateMovement ?? m.effectiveDate ?? 0;
        return {
            id: String(m.id ?? ''),
            date: toLocalDate(timestamp),
            timestamp,
            account: m._cardLabel ? `${account.alias} ${m._cardLabel}` : account.alias,
            accountPortalId: account.portalId,
            description: (m.description ?? '').trim(),
            amount: m.amountMovement ?? 0,
            nature: m.natureMovement ?? '',
            // On a card, 'D' is a charge and 'C' is a payment toward the balance.
            type: natureToType(m.natureMovement),
            balanceAfter: null,
            source: 'credit-card' as const,
        };
    });
}
