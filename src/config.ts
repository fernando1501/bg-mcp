import os from 'node:os';
import path from 'node:path';

/** Banco General's Zona Segura origin. The only host this server ever talks to. */
export const BASE = 'https://zonasegura.bgeneral.com';

/** Where session state lives. Created with 0700 on first write. */
export const STATE_DIR = process.env.BG_MCP_HOME ?? path.join(os.homedir(), '.bg-mcp');
export const SESSION_FILE = path.join(STATE_DIR, 'session.json');

/**
 * Panama is UTC-5 year-round (no DST). BG timestamps are UTC, but the user
 * thinks in Panama local time, so every date boundary and rendered date shifts
 * by this much. Without it a 23:30 transaction lands on the next day.
 */
export const PANAMA_OFFSET_HOURS = 5;

/** Chrome UA — BG's WAF is friendlier to a browser-shaped client. */
export const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** How long a half-finished login (waiting on a security answer or OTP) stays alive. */
export const PENDING_LOGIN_TTL_MS = 5 * 60 * 1000;

/** Interval for the session keep-alive ping. Liferay idles sessions out well before this adds up. */
export const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;

/** Keychain service name used when the user opts into `remember`. */
export const KEYCHAIN_SERVICE = 'bg-mcp';

export const HTTP_TIMEOUT_MS = 30_000;
