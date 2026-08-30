/**
 * Authenticated HTTP client for Banco General.
 *
 * Two invariants this module exists to hold:
 *
 *   - Every request passes `assertReadOnly` before axios sees it.
 *   - No CSRF token is ever attached. BG's state-changing routes require
 *     `x-csrf-token`; by never sending one, the bank rejects writes even if the
 *     guard were somehow bypassed. Do not add it here — the login flow gets its
 *     token inside Playwright, where it stays.
 */

import axios, { type AxiosInstance } from 'axios';

import { BASE, HTTP_TIMEOUT_MS, USER_AGENT } from '../config.js';
import {
    cookieHeader,
    loadSession,
    looksAuthenticated,
    saveSession,
    type SessionRecord,
} from '../auth/session.js';
import { assertReadOnly } from './guard.js';

/** Thrown when BG no longer accepts our cookies. Tools turn this into a hint to re-login. */
export class SessionExpiredError extends Error {
    readonly code = 'SESSION_EXPIRED';
    constructor(message = 'Banco General session expired or was never established.') {
        super(message);
        this.name = 'SessionExpiredError';
    }
}

/** Thrown for non-401 API failures, carrying BG's status and body for diagnosis. */
export class BankApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(method: string, path: string, status: number, body: unknown) {
        super(`${method} ${path} → ${status}: ${JSON.stringify(body)?.slice(0, 300)}`);
        this.name = 'BankApiError';
        this.status = status;
        this.body = body;
    }
}

function buildAxios(session: SessionRecord): AxiosInstance {
    return axios.create({
        baseURL: BASE,
        timeout: HTTP_TIMEOUT_MS,
        maxRedirects: 0,
        headers: {
            Cookie: cookieHeader(session.storageState),
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            Origin: BASE,
            Referer: `${BASE}/group/guest/dashboard`,
            'User-Agent': USER_AGENT,
            // Deliberately no x-csrf-token / x-xsrf-token. See module docs.
        },
        validateStatus: () => true,
    });
}

/**
 * A 302 to the login page is BG's way of saying "your session is gone"; it
 * doesn't bother with a 401. HTML coming back from a JSON endpoint means the
 * same thing.
 */
function isSessionExpiredResponse(status: number, contentType: string, data: unknown): boolean {
    if (status === 401 || status === 403) return true;
    if (status >= 300 && status < 400) return true;
    if (/text\/html/i.test(contentType) && typeof data === 'string' && /login/i.test(data)) {
        return true;
    }
    return false;
}

export class BankClient {
    private http: AxiosInstance | null = null;
    private session: SessionRecord | null = null;

    /**
     * Rebuilds the axios instance from whatever session is on disk. Called on
     * construction and again after any re-login, so a fresh cookie jar takes
     * effect without restarting the server.
     */
    reload(): void {
        this.session = loadSession();
        this.http = looksAuthenticated(this.session) ? buildAxios(this.session) : null;
    }

    isAuthenticated(): boolean {
        if (!this.http) this.reload();
        return this.http !== null;
    }

    getSession(): SessionRecord | null {
        if (!this.session) this.reload();
        return this.session;
    }

    private require(): AxiosInstance {
        if (!this.http) this.reload();
        if (!this.http) throw new SessionExpiredError('Not logged in. Call bg_login_start first.');
        return this.http;
    }

    async get<T = unknown>(path: string, referer?: string): Promise<T> {
        assertReadOnly('GET', path);
        const http = this.require();
        const res = await http.get(path, { headers: referer ? { Referer: referer } : undefined });
        return this.unwrap<T>('GET', path, res);
    }

    async post<T = unknown>(path: string, body: unknown, referer?: string): Promise<T> {
        assertReadOnly('POST', path);
        const http = this.require();
        const res = await http.post(path, body, {
            headers: referer ? { Referer: referer } : undefined,
        });
        return this.unwrap<T>('POST', path, res);
    }

    private unwrap<T>(
        method: string,
        path: string,
        res: { status: number; headers: Record<string, unknown>; data: unknown },
    ): T {
        const contentType = String(res.headers['content-type'] ?? '');
        if (isSessionExpiredResponse(res.status, contentType, res.data)) {
            this.http = null;
            throw new SessionExpiredError();
        }
        if (res.status >= 400) {
            throw new BankApiError(method, path, res.status, res.data);
        }
        // Mark the session as alive so bg_session_status can report freshness.
        if (this.session) {
            this.session.lastVerifiedAt = Date.now();
        }
        return res.data as T;
    }

    /** Persists the refreshed `lastVerifiedAt` back to disk. Cheap, so it runs on keep-alive only. */
    persistFreshness(): void {
        if (this.session) saveSession(this.session);
    }
}

/** One shared client per process — the session is process-wide state. */
export const bank = new BankClient();
