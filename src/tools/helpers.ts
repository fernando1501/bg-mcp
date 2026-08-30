/** Shared plumbing for tool handlers: JSON results and uniform error mapping. */

import { BankApiError, SessionExpiredError } from '../http/client.js';
import { LoginError } from '../auth/login.js';

export interface ToolResult {
    // The SDK's CallToolResult allows arbitrary extra keys; without this index
    // signature our narrower type isn't assignable to it.
    [key: string]: unknown;
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export function jsonResult(data: unknown): ToolResult {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string, code?: string): ToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify({ error: message, code }, null, 2) }],
        isError: true,
    };
}

/**
 * Wraps a handler so every failure reaches the model as a readable message
 * instead of a stack trace. Session expiry gets an explicit next step, since
 * that's the one error the model can actually recover from on its own.
 */
export function guarded<A>(handler: (args: A) => Promise<ToolResult>) {
    return async (args: A): Promise<ToolResult> => {
        try {
            return await handler(args);
        } catch (err) {
            if (err instanceof SessionExpiredError) {
                return errorResult(
                    'The Banco General session has expired. Ask the user for their credentials and call bg_login_start again.',
                    'SESSION_EXPIRED',
                );
            }
            if (err instanceof LoginError) {
                return errorResult(err.message, err.code);
            }
            if (err instanceof BankApiError) {
                return errorResult(err.message, `BANK_${err.status}`);
            }
            return errorResult(err instanceof Error ? err.message : String(err));
        }
    };
}

/** Applies an optional cap so a chatty account can't flood the context window. */
export function limited<T>(items: T[], limit?: number): { items: T[]; truncated: boolean; total: number } {
    if (limit === undefined || items.length <= limit) {
        return { items, truncated: false, total: items.length };
    }
    return { items: items.slice(0, limit), truncated: true, total: items.length };
}
