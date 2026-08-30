/**
 * Banco General login, driven through Playwright.
 *
 * Reverse-engineering the POSTs is brittle: the flow is Liferay's multi-step
 * one, gated by CSRF and anti-bot checks. Driving the real UI and then lifting
 * the cookies is what the budget automation already does successfully, so this
 * is a port of that flow — split into three resumable steps so the security
 * question and any OTP can be relayed back to the user through MCP tools.
 *
 * The browser is headless by default; the `bg-mcp login` CLI runs it headed for
 * first-time device registration.
 */

import { chromium, type Locator, type Page } from 'playwright';

import { BASE } from '../config.js';
import {
    createPendingId,
    discardPending,
    getPending,
    registerPending,
    type PendingLogin,
} from './pending.js';
import { saveCredentials } from './keychain.js';
import { saveSession, type StorageState } from './session.js';

export class LoginError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'LoginError';
        this.code = code;
    }
}

export interface LoginStartResult {
    loginId: string;
    securityQuestion: string;
}

export type LoginAnswerResult =
    | { status: 'authenticated'; username: string; remembered: boolean }
    | { status: 'otp_required'; loginId: string; message: string };

/**
 * Step 1 — submit the username and read back the security question.
 *
 * Leaves the browser open and parked on the security-question screen; the
 * caller must follow up with `submitSecurityAnswer` or the TTL will reap it.
 */
export async function startLogin(
    username: string,
    { headless = true }: { headless?: boolean } = {},
): Promise<LoginStartResult> {
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();

    const id = createPendingId();
    const entry = registerPending({
        id,
        username,
        browser,
        context,
        page,
        lastApiResponse: null,
        securityQuestion: null,
        awaitingOtp: false,
        rememberedPassword: null,
        rememberedAnswer: null,
    });

    // BG returns the security question in the validate-user response, which is
    // more reliable than scraping the rendered label.
    context.on('response', (response) => {
        const url = response.url();
        if (!/api\/jsonws\/invoke/.test(url) && !/login/i.test(url)) return;
        void (async () => {
            try {
                const ct = response.headers()['content-type'] ?? '';
                if (!/json/i.test(ct)) return;
                entry.lastApiResponse = (await response.json()) as Record<string, unknown>;
            } catch {
                // Non-JSON or already-consumed body; ignore.
            }
        })();
    });

    try {
        await page.goto(`${BASE}/web/guest/home#!/login/username`, { waitUntil: 'domcontentloaded' });
        if (!(await waitForUrl(page, [/login\/username/], 15_000))) {
            throw new LoginError('LOGIN_PAGE_NOT_REACHED', `Never reached the username screen (at ${page.url()}).`);
        }

        const userInput = await waitForLoginInput(page, 'text', 15_000);
        await userInput.fill(username);
        await submitCurrentForm(page);

        const step2 = await waitForUrl(page, [/login\/security_question/, /login\/password/], 15_000);
        if (!step2) {
            throw new LoginError(
                'SECURITY_QUESTION_NOT_REACHED',
                `BG did not advance past the username screen (at ${page.url()}). Check the username is correct.`,
            );
        }
        const question = await pollFor(
            () => entry.lastApiResponse?.['securityQuestion'] as string | undefined,
            5_000,
        );
        if (!question) {
            throw new LoginError(
                'NO_SECURITY_QUESTION',
                'Reached the security-question screen but BG never returned the question text.',
            );
        }
        entry.securityQuestion = question;
        entry.lastApiResponse = null;
        return { loginId: id, securityQuestion: question };
    } catch (err) {
        await discardPending(id, 'startLogin failed');
        if (err instanceof LoginError) throw err;
        throw new LoginError('LOGIN_START_FAILED', describe(err, page));
    }
}

/**
 * Step 2 — answer the security question and submit the password.
 *
 * Resolves to `otp_required` (keeping the browser alive) when BG asks for a
 * one-time code instead of dropping straight onto the dashboard.
 */
export async function submitSecurityAnswer(
    loginId: string,
    answer: string,
    password: string,
    remember: boolean,
): Promise<LoginAnswerResult> {
    const entry = requirePending(loginId);
    const { page } = entry;

    try {
        const answerInput = await waitForLoginInput(page, 'text', 10_000);
        await answerInput.fill(answer);
        await submitCurrentForm(page);

        if (!(await waitForUrl(page, [/login\/password/], 20_000))) {
            throw new LoginError(
                'PASSWORD_SCREEN_NOT_REACHED',
                `BG did not advance to the password screen (at ${page.url()}). The security answer may be wrong.`,
            );
        }
        const passwordInput = await waitForLoginInput(page, 'password', 10_000);
        await passwordInput.fill(password);
        entry.lastApiResponse = null;
        await submitCurrentForm(page);

        entry.rememberedPassword = remember ? password : null;
        entry.rememberedAnswer = remember ? answer : null;

        return await settleAfterCredentials(entry, remember);
    } catch (err) {
        if (err instanceof LoginError) throw err;
        await discardPending(loginId, 'submitSecurityAnswer failed');
        throw new LoginError('LOGIN_ANSWER_FAILED', describe(err, page));
    }
}

/** Step 3 — only reached when BG asked for a one-time code. */
export async function submitOtp(loginId: string, code: string): Promise<LoginAnswerResult> {
    const entry = requirePending(loginId);
    if (!entry.awaitingOtp) {
        throw new LoginError('OTP_NOT_REQUESTED', 'This login is not waiting for an OTP code.');
    }
    const { page } = entry;
    try {
        const otpInput = await waitForLoginInput(page, 'text', 10_000);
        await otpInput.fill(code);
        await submitCurrentForm(page);
        entry.awaitingOtp = false;
        return await settleAfterCredentials(entry, entry.rememberedPassword !== null);
    } catch (err) {
        if (err instanceof LoginError) throw err;
        await discardPending(loginId, 'submitOtp failed');
        throw new LoginError('OTP_FAILED', describe(err, page));
    }
}

/**
 * Waits for the dashboard, harvests cookies, and closes the browser. Shared by
 * the password and OTP steps since either can be the last one.
 */
async function settleAfterCredentials(
    entry: PendingLogin,
    remember: boolean,
): Promise<LoginAnswerResult> {
    const { page } = entry;
    // Race the dashboard against the OTP screen so a code prompt is reported
    // immediately instead of after the full dashboard timeout.
    const settled = await waitForUrl(page, [/dashboard/, /otp|token|codigo|c[oó]digo/i], 30_000);

    if (settled?.index === 1) {
        entry.awaitingOtp = true;
        return {
            status: 'otp_required',
            loginId: entry.id,
            message:
                'Banco General sent a one-time code. Ask the user for it and call bg_login_otp with the same loginId.',
        };
    }
    if (!settled) {
        throw new LoginError(
            'DASHBOARD_NOT_REACHED',
            `Login did not reach the dashboard. Current URL: ${page.url()}. ` +
                'If this device is not trusted yet, run `bg-mcp login` once to complete it in a visible browser.',
        );
    }

    // Landing on /dashboard only means the SPA routed; the session cookie can
    // still be in flight. Saving here without it would persist a dead session.
    const gotCookie = await pollFor(async () => {
        const cookies = await entry.context.cookies();
        return cookies.some((c) => c.name.toUpperCase().includes('SESSION')) || undefined;
    }, 10_000);
    if (!gotCookie) {
        throw new LoginError(
            'NO_SESSION_COOKIE',
            'Reached the dashboard but Banco General never set a session cookie.',
        );
    }

    const storageState = (await entry.context.storageState()) as unknown as StorageState;
    saveSession({
        username: entry.username,
        loggedInAt: Date.now(),
        lastVerifiedAt: Date.now(),
        remembered: remember,
        storageState,
    });

    let stored = false;
    if (remember && entry.rememberedPassword) {
        stored = await saveCredentials({
            username: entry.username,
            password: entry.rememberedPassword,
            securityAnswer: entry.rememberedAnswer ?? '',
        });
    }

    // Drop the plaintext credentials from memory now that we're done with them.
    entry.rememberedPassword = null;
    entry.rememberedAnswer = null;
    await discardPending(entry.id, 'login complete');

    return { status: 'authenticated', username: entry.username, remembered: stored };
}

/**
 * Full non-interactive login from stored credentials, used to recover silently
 * when BG expires a session. Only possible when the user opted into `remember`.
 */
export async function silentRelogin(
    username: string,
    password: string,
    securityAnswer: string,
): Promise<boolean> {
    try {
        const { loginId } = await startLogin(username);
        const result = await submitSecurityAnswer(loginId, securityAnswer, password, true);
        if (result.status === 'otp_required') {
            // Can't answer an OTP without the user; give up and let them re-login.
            await discardPending(loginId, 'silent relogin hit OTP');
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function requirePending(loginId: string): PendingLogin {
    const entry = getPending(loginId);
    if (!entry) {
        throw new LoginError(
            'UNKNOWN_LOGIN_ID',
            'No login in progress for that loginId — it expired or was already completed. Start over with bg_login_start.',
        );
    }
    return entry;
}

/**
 * Returns the only visible, editable input of the requested kind on the current
 * step. Angular re-renders between steps, so this polls rather than querying once.
 */
async function waitForLoginInput(
    page: Page,
    kind: 'text' | 'password',
    timeoutMs: number,
): Promise<Locator> {
    const selector =
        kind === 'password'
            ? 'input[type="password"]'
            : 'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const candidates = page.locator(selector);
        const count = await candidates.count();
        for (let i = 0; i < count; i += 1) {
            const el = candidates.nth(i);
            if ((await el.isVisible()) && (await el.isEditable())) return el;
        }
        await page.waitForTimeout(250);
    }
    throw new LoginError('INPUT_NOT_FOUND', `Timed out waiting for the ${kind} input.`);
}

async function submitCurrentForm(page: Page): Promise<void> {
    const btn = page
        .locator(
            'button[type="submit"]:visible, button:has-text("Continuar"):visible, button:has-text("Entrar"):visible, button:has-text("Iniciar"):visible',
        )
        .first();
    if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
    } else {
        await page.keyboard.press('Enter');
    }
}

/** Polls a thunk (sync or async) until it yields something truthy, or times out. */
async function pollFor<T>(
    thunk: () => T | undefined | Promise<T | undefined>,
    timeoutMs: number,
): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await thunk();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 100));
    }
    return null;
}

/**
 * Waits until the page's URL matches one of `patterns`, returning the index of
 * the one that hit.
 *
 * Deliberately polls `page.url()` instead of using `page.waitForURL`: the
 * dashboard is an Angular app that holds connections open and never reaches the
 * `load` state Playwright waits for, so `waitForURL` times out even once the
 * navigation has plainly happened. Polling only cares about the URL.
 */
async function waitForUrl(
    page: Page,
    patterns: RegExp[],
    timeoutMs: number,
): Promise<{ index: number; url: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let url = '';
        try {
            url = page.url();
        } catch {
            return null; // Page closed underneath us.
        }
        const index = patterns.findIndex((p) => p.test(url));
        if (index !== -1) return { index, url };
        await new Promise((r) => setTimeout(r, 200));
    }
    return null;
}

/** Error text plus the URL we were stuck on — the single most useful debugging detail. */
function describe(err: unknown, page: Page): string {
    const message = err instanceof Error ? err.message : String(err);
    let url = '';
    try {
        url = page.url();
    } catch {
        // Page already closed.
    }
    return url ? `${message} (at ${url})` : message;
}
