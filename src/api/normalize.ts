/**
 * Shapes returned to the model, and the date arithmetic that makes them right.
 *
 * BG timestamps are UTC epoch millis, but the user reasons in Panama local time
 * (UTC-5, no DST). Rendering a 23:30 transaction without the shift moves it to
 * the next day, which silently corrupts any month-boundary total.
 */

import { PANAMA_OFFSET_HOURS } from '../config.js';

export interface Account {
    /** Numeric id BG uses as `:id` in URLs and as `productId` in bodies. */
    portalId: number;
    /** 'SavingsAccount' | 'CreditCard' | 'BGProfuture' | ... */
    classType: string;
    productType: string;
    /** User-visible nickname, e.g. 'Savings', 'yappy'. */
    alias: string;
    maskedNumber: string;
    currentBalance: number | null;
    availableBalance: number | null;
    currentBalanceLabel: string | null;
    availableBalanceLabel: string | null;
    /** Epoch ms of BG's last sync — balances are as-of this moment, not live. */
    lastSyncDate: number | null;
    lastSyncDateLocal: string | null;
}

export interface Transaction {
    id: string;
    /** YYYY-MM-DD in Panama local time. */
    date: string;
    /** Original UTC epoch ms, kept so callers can sort precisely. */
    timestamp: number;
    account: string;
    accountPortalId: number;
    description: string;
    amount: number;
    /** 'C' (credit) or 'D' (debit) as BG reports it. */
    nature: string;
    /** Derived: 'Ingreso' for credits, 'Gasto' for debits. */
    type: 'Ingreso' | 'Gasto' | '';
    /** Running balance after this movement, when BG provides it. */
    balanceAfter: number | null;
    source: 'savings' | 'credit-card';
}

/** Renders a UTC epoch as a Panama-local YYYY-MM-DD. */
export function toLocalDate(timestamp: number | null | undefined): string {
    if (!timestamp) return '';
    return new Date(timestamp - PANAMA_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10);
}

/**
 * UTC bounds of a Panama-local calendar month.
 * `monthIdx` is 0-based, matching Date.getUTCMonth().
 */
export function monthRange(year: number, monthIdx: number): { start: Date; end: Date } {
    const start = new Date(Date.UTC(year, monthIdx, 1, PANAMA_OFFSET_HOURS, 0, 0));
    const end = new Date(Date.UTC(year, monthIdx + 1, 1, PANAMA_OFFSET_HOURS, 0, 0) - 1000);
    return { start, end };
}

/** Parses 'YYYY-MM-DD' as Panama local midnight, expressed in UTC. */
export function parseLocalDate(iso: string, endOfDay = false): Date {
    const [y, m, d] = iso.split('-').map(Number);
    const hours = PANAMA_OFFSET_HOURS + (endOfDay ? 24 : 0);
    const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hours, 0, 0);
    return new Date(endOfDay ? base - 1000 : base);
}

export function natureToType(nature: string | undefined): 'Ingreso' | 'Gasto' | '' {
    if (nature === 'C') return 'Ingreso';
    if (nature === 'D') return 'Gasto';
    return '';
}

/**
 * BG routinely returns movements outside the window it was asked for: savings
 * `find` can overshoot by a day, and credit-card `find` returns the whole
 * statement period, which starts on the previous month's cutoff. Trust the
 * Panama-local date and drop the rest.
 */
export function clampToDateRange(
    transactions: Transaction[],
    fromDate: string,
    toDate: string,
): Transaction[] {
    return transactions.filter((t) => t.date >= fromDate && t.date <= toDate);
}

interface RawAccount {
    portalId?: number;
    sequence?: number;
    classType?: string;
    productType?: string;
    name?: string;
    alias?: string;
    maskedNumber?: string;
    currentBalance?: number;
    availableBalance?: number;
    currentBalanceLabel?: string;
    availableBalanceLabel?: string;
    lastSyncDate?: number;
}

interface RawProductGroup {
    products?: Array<{ name?: string; accounts?: RawAccount[] }>;
}

/**
 * Flattens the three-level dashboard/product response (group → product →
 * accounts) into a flat list, which is what every caller actually wants.
 */
export function flattenAccounts(groups: RawProductGroup[] | null | undefined): Account[] {
    const out: Account[] = [];
    for (const group of groups ?? []) {
        for (const product of group.products ?? []) {
            for (const acc of product.accounts ?? []) {
                out.push({
                    portalId: acc.portalId ?? acc.sequence ?? -1,
                    classType: acc.classType ?? '',
                    productType: acc.productType ?? product.name ?? '',
                    alias: acc.name ?? acc.alias ?? '',
                    maskedNumber: acc.maskedNumber ?? '',
                    currentBalance: acc.currentBalance ?? null,
                    availableBalance: acc.availableBalance ?? null,
                    currentBalanceLabel: acc.currentBalanceLabel ?? null,
                    availableBalanceLabel: acc.availableBalanceLabel ?? null,
                    lastSyncDate: acc.lastSyncDate ?? null,
                    lastSyncDateLocal: toLocalDate(acc.lastSyncDate),
                });
            }
        }
    }
    return out;
}
