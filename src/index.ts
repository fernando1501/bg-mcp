#!/usr/bin/env node
/**
 * bg-mcp — a read-only MCP (stdio) server for Banco General's Zona Segura.
 *
 * Everything this server can reach is enumerated in http/guard.ts. There are no
 * tools that move money, and the HTTP layer refuses any route that isn't on the
 * read allowlist.
 *
 * Nothing may be written to stdout except MCP protocol frames — stdout *is* the
 * transport. All logging goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { KEEPALIVE_INTERVAL_MS } from './config.js';
import { bank } from './http/client.js';
import { registerAccountTools } from './tools/accounts.tools.js';
import { registerAnalyticsTools } from './tools/analytics.tools.js';
import { registerAuthTools } from './tools/auth.tools.js';
import { registerCardTools } from './tools/cards.tools.js';
import { registerTransactionTools } from './tools/transactions.tools.js';

const log = (msg: string) => process.stderr.write(`[bg-mcp] ${msg}\n`);

/**
 * Liferay idles sessions out, so a long-lived server would otherwise force a
 * re-login every time the user comes back. A cheap read keeps it warm.
 */
function startKeepAlive(): NodeJS.Timeout {
    const timer = setInterval(() => {
        if (!bank.isAuthenticated()) return;
        bank
            .get('/o/api/dashboard/tour')
            .then(() => bank.persistFreshness())
            .catch(() => {
                // Session is gone; the next real tool call reports it properly.
            });
    }, KEEPALIVE_INTERVAL_MS);
    timer.unref();
    return timer;
}

async function main(): Promise<void> {
    const server = new McpServer(
        { name: 'bg-mcp', version: '0.1.0' },
        {
            instructions:
                'Read-only access to the user\'s Banco General accounts. This server can ONLY read: it cannot ' +
                'transfer money, pay bills, or change anything in the account.\n\n' +
                'Start with bg_session_status. If it reports authenticated: false, stop and log the user in ' +
                'before answering anything about their money: ask for their username, call bg_login_start, relay ' +
                'the security question it returns, then call bg_login_answer with the answer and password. ' +
                'Never present balances, totals or "no results" from an unauthenticated session as facts about ' +
                'the user\'s finances — say the login is needed instead.\n\n' +
                'Then call bg_list_accounts to get the portalIds every other tool needs. All dates are Panama ' +
                'local time (UTC-5). Balances reflect BG\'s lastSyncDate, not the live moment.',
        },
    );

    registerAuthTools(server);
    registerAccountTools(server);
    registerTransactionTools(server);
    registerCardTools(server);
    registerAnalyticsTools(server);

    bank.reload();
    log(bank.isAuthenticated() ? 'Existing session loaded.' : 'No session yet — login required.');

    startKeepAlive();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Server ready on stdio (read-only).');
}

main().catch((err: unknown) => {
    log(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
});
