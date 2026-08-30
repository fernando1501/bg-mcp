/**
 * Savings-account movements.
 *
 * Pagination model (observed, and already proven in the budget automation):
 * BG uses a `seqNumber` cursor — 0 on the first call, then the smallest
 * `seqAccount` seen on the previous page. The `page` field is informational
 * only. BG also returns duplicate rows sharing an `id` (a commission row and
 * its parent transfer, say), so dedup is on the composite `id#seqAccount`,
 * which is genuinely unique per account.
 */

import { bank } from '../http/client.js';
import { savingsReferer } from './accounts.js';
import { natureToType, toLocalDate, type Transaction } from './normalize.js';

interface RawSavingsMovement {
    id?: string;
    dateMovement?: number;
    natureMovement?: string;
    amountMovement?: number;
    description?: string;
    seqAccount?: number;
    capitalBalance?: number;
    availableBalance?: number;
}

interface SavingsFindResponse {
    productMovements?: RawSavingsMovement[];
}

const PAGE_SIZE_HINT = 10;
const MAX_PAGES = 200;

export async function getSavingsMovements(
    portalId: number,
    initDate: Date,
    endDate: Date,
): Promise<RawSavingsMovement[]> {
    const referer = savingsReferer(portalId);
    const all: RawSavingsMovement[] = [];
    const seen = new Set<string>();
    let seqNumber = 0;
    let page = 1;

    while (page <= MAX_PAGES) {
        const body = {
            productId: String(portalId),
            seqNumber,
            productType: null,
            initDate: initDate.toISOString(),
            endDate: endDate.getTime(),
            page,
            order: 'D',
            countableBalance: 0,
        };
        const res = await bank.post<SavingsFindResponse>(
            '/o/api/product-info/saving-account/find',
            body,
            referer,
        );
        const movements = res?.productMovements ?? [];
        if (movements.length === 0) break;

        let newCount = 0;
        let minSeq = Infinity;
        for (const m of movements) {
            const key = `${m.id}#${m.seqAccount}`;
            if (!seen.has(key)) {
                seen.add(key);
                all.push(m);
                newCount += 1;
            }
            if (typeof m.seqAccount === 'number') minSeq = Math.min(minSeq, m.seqAccount);
        }

        // BG sometimes ignores the cursor and replays the same page — stop
        // rather than loop until MAX_PAGES.
        if (newCount === 0) break;
        if (movements.length < PAGE_SIZE_HINT) break;
        if (!Number.isFinite(minSeq)) break;

        seqNumber = minSeq;
        page += 1;
    }
    return all;
}

export function normalizeSavingsMovements(
    movements: RawSavingsMovement[],
    account: { portalId: number; alias: string; maskedNumber: string },
): Transaction[] {
    return movements.map((m) => ({
        id: String(m.id ?? ''),
        date: toLocalDate(m.dateMovement),
        timestamp: m.dateMovement ?? 0,
        account: account.alias || account.maskedNumber,
        accountPortalId: account.portalId,
        description: (m.description ?? '').trim(),
        amount: m.amountMovement ?? 0,
        nature: m.natureMovement ?? '',
        type: natureToType(m.natureMovement),
        balanceAfter: m.capitalBalance ?? m.availableBalance ?? null,
        source: 'savings' as const,
    }));
}

/** Last ~20 movements without a date range — cheap "what happened recently". */
export async function getRecentSavingsMovements(portalId: number): Promise<RawSavingsMovement[]> {
    const res = await bank.get<RawSavingsMovement[]>(
        `/o/api/product-info/saving-account/movement/${portalId}`,
        savingsReferer(portalId),
    );
    return Array.isArray(res) ? res : [];
}
