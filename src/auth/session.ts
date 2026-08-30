/**
 * Session persistence.
 *
 * We store exactly what Playwright's `storageState` gives us (cookies +
 * localStorage) plus a little metadata about who logged in and when.
 * Credentials are never written here — see auth/keychain.ts for the opt-in
 * `remember` path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SESSION_FILE, STATE_DIR } from '../config.js';

export interface StoredCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
}

export interface StorageState {
    cookies: StoredCookie[];
    origins: unknown[];
}

export interface SessionRecord {
    /** BG username that produced this session. Shown by bg_session_status. */
    username: string;
    /** Epoch ms when the login completed. */
    loggedInAt: number;
    /** Epoch ms of the last successful authenticated request. */
    lastVerifiedAt: number;
    /** Whether credentials were stashed in the keychain for silent re-login. */
    remembered: boolean;
    storageState: StorageState;
}

function ensureStateDir(): void {
    if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    }
}

export function saveSession(record: SessionRecord): void {
    ensureStateDir();
    // Write through a temp file so a crash mid-write can't leave a truncated
    // session behind, and create it 0600 from the start rather than chmod after.
    const tmp = path.join(STATE_DIR, `.session.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, SESSION_FILE);
    fs.chmodSync(SESSION_FILE, 0o600);
}

export function loadSession(): SessionRecord | null {
    try {
        const raw = fs.readFileSync(SESSION_FILE, 'utf8');
        const parsed = JSON.parse(raw) as SessionRecord;
        if (!parsed?.storageState?.cookies) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function clearSession(): boolean {
    try {
        fs.unlinkSync(SESSION_FILE);
        return true;
    } catch {
        return false;
    }
}

export function touchSession(): void {
    const session = loadSession();
    if (!session) return;
    session.lastVerifiedAt = Date.now();
    saveSession(session);
}

/** Serializes cookies into a `Cookie:` header value for axios. */
export function cookieHeader(state: StorageState): string {
    return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * True when the stored cookies look usable. This is a cheap local check — BG
 * can still have invalidated the session server-side, which surfaces as a
 * SESSION_EXPIRED error on the next call.
 */
export function looksAuthenticated(session: SessionRecord | null): session is SessionRecord {
    if (!session) return false;
    const nowSeconds = Date.now() / 1000;
    const live = session.storageState.cookies.filter(
        (c) => c.expires === -1 || c.expires > nowSeconds,
    );
    return live.some((c) => c.name.toUpperCase().includes('SESSION'));
}
