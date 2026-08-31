/**
 * Session lifecycle tools.
 *
 * The login is split across three tools because BG's security question is only
 * revealed after the username is submitted — the model has to relay it to the
 * user and come back with the answer.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { startLogin, submitOtp, submitSecurityAnswer } from '../auth/login.js';
import { deleteCredentials } from '../auth/keychain.js';
import { discardAll } from '../auth/pending.js';
import { clearSession, loadSession, looksAuthenticated } from '../auth/session.js';
import { bank, SessionExpiredError } from '../http/client.js';
import { guarded, jsonResult } from './helpers.js';

export function registerAuthTools(server: McpServer): void {
    server.registerTool(
        'bg_login_start',
        {
            title: 'Start Banco General login',
            description:
                'Step 1 of 3. Submits the username and returns the security question BG asks for. ' +
                'Relay that question to the user, then call bg_login_answer with their answer and password. ' +
                'The login expires after 5 minutes if not completed.',
            inputSchema: {
                username: z.string().min(1).describe("The user's Banco General username (usuario de Zona Segura)."),
            },
        },
        guarded(async ({ username }: { username: string }) => {
            const result = await startLogin(username);
            return jsonResult({
                loginId: result.loginId,
                securityQuestion: result.securityQuestion,
                nextStep:
                    'Ask the user this security question and their password, then call bg_login_answer with the same loginId.',
            });
        }),
    );

    server.registerTool(
        'bg_login_answer',
        {
            title: 'Answer security question and submit password',
            description:
                'Step 2 of 3. Completes the login with the security answer and password. ' +
                'Returns { status: "authenticated" } on success, or { status: "otp_required" } if BG sends a ' +
                'one-time code — in that case ask the user for the code and call bg_login_otp.',
            inputSchema: {
                loginId: z.string().describe('The loginId returned by bg_login_start.'),
                answer: z.string().min(1).describe('The user\'s answer to the security question.'),
                password: z.string().min(1).describe('The user\'s Banco General password.'),
                remember: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe(
                        'Store credentials in the macOS Keychain so the server can re-login silently when BG ' +
                        'expires the session. Only set this if the user explicitly asks to stay logged in.',
                    ),
            },
        },
        guarded(
            async ({
                loginId,
                answer,
                password,
                remember,
            }: {
                loginId: string;
                answer: string;
                password: string;
                remember?: boolean;
            }) => {
                const result = await submitSecurityAnswer(loginId, answer, password, remember ?? false);
                if (result.status === 'authenticated') {
                    bank.reload();
                }
                return jsonResult(result);
            },
        ),
    );

    server.registerTool(
        'bg_login_otp',
        {
            title: 'Submit one-time code',
            description:
                'Step 3 of 3, only needed when bg_login_answer returned status "otp_required". ' +
                'Submits the code Banco General sent to the user.',
            inputSchema: {
                loginId: z.string().describe('The same loginId used in the previous steps.'),
                code: z.string().min(1).describe('The one-time code the user received.'),
            },
        },
        guarded(async ({ loginId, code }: { loginId: string; code: string }) => {
            const result = await submitOtp(loginId, code);
            if (result.status === 'authenticated') {
                bank.reload();
            }
            return jsonResult(result);
        }),
    );

    server.registerTool(
        'bg_session_status',
        {
            title: 'Check session status',
            description:
                'Reports whether there is a usable Banco General session, who it belongs to, and how fresh it is. ' +
                'Verifies against the bank rather than trusting the stored session file. ' +
                'Call this before asking the user for credentials — they may already be logged in. ' +
                'If it reports authenticated: false, log in before answering anything about the accounts; ' +
                'the data tools have nothing to read and will fail.',
            inputSchema: {},
        },
        guarded(async () => {
            const session = loadSession();
            if (!looksAuthenticated(session)) {
                return jsonResult({
                    authenticated: false,
                    reason: session ? 'stored_session_unusable' : 'no_session',
                    nextStep:
                        'Ask the user for their username and call bg_login_start. Do not report balances or ' +
                        'spending until the login completes.',
                });
            }

            // The stored cookies can look perfectly fine here and still be dead:
            // BG's session cookie carries no expiry, so the file alone can never
            // say. Only the bank knows, so ask it — reporting a stale session as
            // live is what makes every later tool answer with empty data instead
            // of asking the user to log in.
            try {
                await bank.get('/o/api/dashboard/tour');
            } catch (err) {
                if (err instanceof SessionExpiredError) {
                    return jsonResult({
                        authenticated: false,
                        reason: 'expired',
                        username: session.username,
                        nextStep:
                            'The stored session is no longer valid. Ask the user for their credentials and call ' +
                            'bg_login_start. Do not report balances or spending until the login completes.',
                    });
                }
                throw err;
            }

            bank.persistFreshness();
            return jsonResult({
                authenticated: true,
                username: session.username,
                loggedInAt: new Date(session.loggedInAt).toISOString(),
                verifiedAt: new Date().toISOString(),
                credentialsRemembered: session.remembered,
            });
        }),
    );

    server.registerTool(
        'bg_logout',
        {
            title: 'Log out of Banco General',
            description:
                'Deletes the stored session and any credentials kept in the Keychain, and closes any login in progress.',
            inputSchema: {},
        },
        guarded(async () => {
            const session = loadSession();
            discardAll('logout');
            const sessionCleared = clearSession();
            let credentialsCleared = false;
            if (session?.username) {
                credentialsCleared = await deleteCredentials(session.username);
            }
            bank.reload();
            return jsonResult({ sessionCleared, credentialsCleared });
        }),
    );
}
