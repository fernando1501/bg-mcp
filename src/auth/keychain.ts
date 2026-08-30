/**
 * Optional credential storage in the macOS Keychain.
 *
 * Off by default. The user opts in per-login with `remember: true`, which is
 * what makes "log in once, don't get asked again until logout" actually true:
 * BG expires sessions server-side on its own schedule, and without stored
 * credentials the only recovery is to ask the user for their password again.
 *
 * Credentials go to the Keychain via `security(1)` and never to a file we own.
 * On non-macOS platforms every function degrades to a no-op and `remember`
 * silently behaves as false.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { KEYCHAIN_SERVICE } from '../config.js';

const execFileAsync = promisify(execFile);

export interface StoredCredentials {
    username: string;
    password: string;
    securityAnswer: string;
}

export function keychainAvailable(): boolean {
    return process.platform === 'darwin';
}

/**
 * The three secrets are stored as one JSON blob under a single account so a
 * logout only has to delete one entry.
 */
export async function saveCredentials(creds: StoredCredentials): Promise<boolean> {
    if (!keychainAvailable()) return false;
    const payload = JSON.stringify({
        password: creds.password,
        securityAnswer: creds.securityAnswer,
    });
    try {
        await execFileAsync('security', [
            'add-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', creds.username,
            '-w', payload,
            '-U', // update in place if it already exists
        ]);
        return true;
    } catch {
        return false;
    }
}

export async function loadCredentials(username: string): Promise<StoredCredentials | null> {
    if (!keychainAvailable()) return null;
    try {
        const { stdout } = await execFileAsync('security', [
            'find-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', username,
            '-w',
        ]);
        const parsed = JSON.parse(stdout.trim()) as { password: string; securityAnswer: string };
        if (!parsed.password) return null;
        return { username, password: parsed.password, securityAnswer: parsed.securityAnswer ?? '' };
    } catch {
        return null;
    }
}

export async function deleteCredentials(username: string): Promise<boolean> {
    if (!keychainAvailable()) return false;
    try {
        await execFileAsync('security', [
            'delete-generic-password',
            '-s', KEYCHAIN_SERVICE,
            '-a', username,
        ]);
        return true;
    } catch {
        return false;
    }
}
