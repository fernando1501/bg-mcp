/**
 * Read-only enforcement.
 *
 * This module is the reason the server can claim it cannot move money. Every
 * request the process makes to Banco General goes through `assertReadOnly`
 * first, and anything that is not on the allowlist never leaves the process.
 *
 * Three layers, all deliberately redundant:
 *
 *   1. A blocklist of known state-changing path fragments, checked first so a
 *      careless allowlist edit can't accidentally open a transfer endpoint.
 *   2. An exact (method, path) allowlist. Note that several *read* endpoints on
 *      BG are POST (`find`, `state`, `statement`), so filtering by HTTP verb
 *      alone would be useless — matching is per-route.
 *   3. No CSRF token, ever (enforced in http/client.ts). Liferay requires
 *      `x-csrf-token` on state-changing routes, so even a hypothetical bypass
 *      of layers 1 and 2 would be rejected by the bank itself.
 *
 * Callers never supply a path or a request body: every function in src/api
 * builds its own from zod-validated arguments.
 */

export interface ReadOnlyEndpoint {
    /** HTTP method BG expects for this route. */
    method: 'GET' | 'POST';
    /** Anchored pattern matched against the pathname (no query string). */
    pattern: RegExp;
    /** Human-readable name, surfaced in errors and used by the tests. */
    name: string;
}

/**
 * The complete set of endpoints this server is allowed to call. Adding a row
 * here is the only way to widen the server's reach — do it deliberately, and
 * only for routes that read.
 */
export const READ_ONLY_ENDPOINTS: readonly ReadOnlyEndpoint[] = [
    // --- Dashboard ---------------------------------------------------------
    { method: 'GET', pattern: /^\/o\/api\/dashboard\/product$/, name: 'dashboard.product' },
    { method: 'GET', pattern: /^\/o\/api\/dashboard\/tour$/, name: 'dashboard.tour' },
    { method: 'GET', pattern: /^\/o\/api\/dashboard\/next-transactions\/init$/, name: 'dashboard.nextTransactions' },

    // --- Savings accounts --------------------------------------------------
    { method: 'GET', pattern: /^\/o\/api\/product-info\/saving-account\/state\/\d+$/, name: 'savings.state' },
    { method: 'GET', pattern: /^\/o\/api\/product-info\/saving-account\/movement\/\d+$/, name: 'savings.recentMovements' },
    { method: 'GET', pattern: /^\/o\/api\/product-info\/saving-account\/associated-account-card\/\d+$/, name: 'savings.associatedCards' },
    { method: 'GET', pattern: /^\/o\/api\/product-info\/saving-account\/trx-transit\/\d+$/, name: 'savings.transitTransactions' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/saving-account\/find$/, name: 'savings.find' },

    // --- Credit cards ------------------------------------------------------
    { method: 'GET', pattern: /^\/o\/api\/product-info\/credit-card\/associated-credit-card\/\d+$/, name: 'card.associatedCards' },
    { method: 'GET', pattern: /^\/o\/api\/product-info\/credit-card\/credit-card-statement-history\/\d+$/, name: 'card.statementHistory' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/state$/, name: 'card.state' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/state-card$/, name: 'card.stateCard' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/find$/, name: 'card.find' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/credit-card-categories-totals$/, name: 'card.categoryTotals' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/get-categories-catalog$/, name: 'card.categoryCatalog' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/credit-card\/status-label$/, name: 'card.statusLabel' },

    // --- Pro-Futuro pension ------------------------------------------------
    { method: 'GET', pattern: /^\/o\/api\/product-info\/profuture\/state\/\d+$/, name: 'pension.state' },
    { method: 'POST', pattern: /^\/o\/api\/product-info\/profuture\/statement\/$/, name: 'pension.statement' },
];

/**
 * Path fragments that must never be requested, whatever the allowlist says.
 *
 * `/api/jsonws/invoke` is Liferay's generic RPC gateway — it can reach any
 * portlet service, including the ones that move money, so it is banned outright
 * even though the login flow needs it (that runs inside Playwright, not here).
 */
const MUTATION_BLOCKLIST: readonly RegExp[] = [
    /\/api\/jsonws\/invoke/,
    /\/transfer/,
    /\/cuentas-propias/,
    /\/terceros/,
    /\/internacionales/,
    /\/pagos?\b/,
    /\/pagar-/,
    /\/pay-card\//,
    /\/reportar-/,
    /\/solicitar-pin/,
    /\/editar-cuenta/,
    /\/toggle-account/,
    /\/watch-later/,
    /\/favoritos/,
    /\/ach\b/,
    /\/yappy\/send/,
];

export class ReadOnlyViolationError extends Error {
    readonly method: string;
    readonly path: string;

    constructor(method: string, path: string, reason: string) {
        super(`Blocked by read-only guard: ${method} ${path} — ${reason}`);
        this.name = 'ReadOnlyViolationError';
        this.method = method;
        this.path = path;
    }
}

/** Strips the query string and normalizes to a leading-slash pathname. */
function normalizePath(rawPath: string): string {
    const withoutQuery = rawPath.split('?')[0] ?? '';
    const withoutHash = withoutQuery.split('#')[0] ?? '';
    return withoutHash.startsWith('/') ? withoutHash : `/${withoutHash}`;
}

/**
 * Throws unless (method, path) is an explicitly allowed read endpoint.
 * Returns the matched endpoint so callers can log which route was used.
 */
export function assertReadOnly(method: string, rawPath: string): ReadOnlyEndpoint {
    const upperMethod = method.toUpperCase();
    const path = normalizePath(rawPath);

    // An absolute URL means someone bypassed the axios baseURL — refuse rather
    // than try to reason about which host it points at.
    if (/^https?:\/\//i.test(rawPath)) {
        throw new ReadOnlyViolationError(upperMethod, rawPath, 'absolute URLs are not allowed');
    }

    for (const blocked of MUTATION_BLOCKLIST) {
        if (blocked.test(path)) {
            throw new ReadOnlyViolationError(upperMethod, path, `matches mutation blocklist ${blocked}`);
        }
    }

    const match = READ_ONLY_ENDPOINTS.find(
        (endpoint) => endpoint.method === upperMethod && endpoint.pattern.test(path),
    );
    if (!match) {
        const allowedWithOtherMethod = READ_ONLY_ENDPOINTS.some((e) => e.pattern.test(path));
        throw new ReadOnlyViolationError(
            upperMethod,
            path,
            allowedWithOtherMethod
                ? 'route is read-only but only via a different HTTP method'
                : 'route is not on the read-only allowlist',
        );
    }
    return match;
}

/** Non-throwing variant, for tests and diagnostics. */
export function isReadOnly(method: string, path: string): boolean {
    try {
        assertReadOnly(method, path);
        return true;
    } catch {
        return false;
    }
}
