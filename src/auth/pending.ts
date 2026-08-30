/**
 * In-memory registry of half-finished logins.
 *
 * BG's login is three screens (username → security question → password), and
 * the security question is only known after step 1. That maps badly onto a
 * single tool call, so each step is its own tool and the live browser waits
 * here in between, keyed by an opaque `loginId`.
 *
 * Every entry has a TTL so an abandoned login can't leave a Chromium process
 * running forever holding a half-authenticated session.
 */

import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from 'playwright';

import { PENDING_LOGIN_TTL_MS } from '../config.js';

export interface PendingLogin {
    id: string;
    username: string;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    /** Last JSON body seen on a login-related response — carries `securityQuestion`. */
    lastApiResponse: Record<string, unknown> | null;
    /** Security question text read in step 1, echoed back to the caller. */
    securityQuestion: string | null;
    /** Set once the password step succeeds but OTP is still pending. */
    awaitingOtp: boolean;
    /** Kept only in memory, only to write to the Keychain if `remember` was set. */
    rememberedPassword: string | null;
    rememberedAnswer: string | null;
    createdAt: number;
    timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingLogin>();

export function createPendingId(): string {
    return randomUUID();
}

export function registerPending(
    entry: Omit<PendingLogin, 'timer' | 'createdAt'>,
): PendingLogin {
    // A second login attempt supersedes the first — don't leak the old browser.
    discardAll('superseded by a new login attempt');

    const full: PendingLogin = {
        ...entry,
        createdAt: Date.now(),
        timer: setTimeout(() => {
            void discardPending(entry.id, 'login timed out');
        }, PENDING_LOGIN_TTL_MS),
    };
    // Don't hold the event loop open just for an abandoned login.
    full.timer.unref?.();
    pending.set(entry.id, full);
    return full;
}

export function getPending(id: string): PendingLogin | null {
    return pending.get(id) ?? null;
}

export async function discardPending(id: string, _reason?: string): Promise<void> {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    try {
        await entry.browser.close();
    } catch {
        // Browser may already be gone; nothing useful to do.
    }
}

export function discardAll(reason?: string): void {
    for (const id of [...pending.keys()]) {
        void discardPending(id, reason);
    }
}

export function pendingCount(): number {
    return pending.size;
}

// Best-effort cleanup so `Ctrl-C` on the host doesn't orphan Chromium.
for (const signal of ['exit', 'SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => discardAll(`process ${signal}`));
}
