/** Pro-Futuro pension fund (BG_PROFUTURE products). */

import { bank } from '../http/client.js';
import { pensionReferer } from './accounts.js';

/** Current fund balances and per-fund breakdown. */
export async function getPensionState(portalId: number): Promise<unknown> {
    return bank.get(
        `/o/api/product-info/profuture/state/${portalId}`,
        pensionReferer(portalId),
    );
}

/**
 * Monthly statement: contributions, interest, commissions and withdrawals.
 * `month` is 1-based here, matching what the portal sends.
 */
export async function getPensionStatement(
    portalId: number,
    month: number,
    year: number,
): Promise<unknown> {
    return bank.post(
        '/o/api/product-info/profuture/statement/',
        { productId: String(portalId), type: null, month, year },
        pensionReferer(portalId),
    );
}
