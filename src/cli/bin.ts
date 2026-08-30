#!/usr/bin/env node
/**
 * `bg-mcp` CLI.
 *
 * Exists mainly for `bg-mcp login`, which runs the same login flow in a visible
 * browser. That's the escape hatch when BG wants a one-time code or wants to
 * register the device — situations the headless tool flow can't finish on its
 * own. It writes the same session file the server reads.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { startLogin, submitOtp, submitSecurityAnswer } from '../auth/login.js';
import { clearSession, loadSession, looksAuthenticated } from '../auth/session.js';
import { deleteCredentials } from '../auth/keychain.js';
import { SESSION_FILE } from '../config.js';

async function cmdLogin(headless: boolean): Promise<void> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
        const username = (await rl.question('Usuario de Banco General: ')).trim();
        if (!username) throw new Error('Username is required.');

        console.log('Opening browser…');
        const { loginId, securityQuestion } = await startLogin(username, { headless });

        console.log(`\nPregunta de seguridad: ${securityQuestion}`);
        const answer = (await rl.question('Respuesta: ')).trim();
        const password = (await rl.question('Contraseña: ')).trim();
        const rememberRaw = (await rl.question('¿Recordar credenciales en el Keychain? [y/N] ')).trim();
        const remember = /^y(es)?$/i.test(rememberRaw);

        let result = await submitSecurityAnswer(loginId, answer, password, remember);

        if (result.status === 'otp_required') {
            console.log('\nBanco General envió un código de un solo uso.');
            const code = (await rl.question('Código: ')).trim();
            result = await submitOtp(loginId, code);
        }

        if (result.status === 'authenticated') {
            console.log(`\n✅ Sesión guardada en ${SESSION_FILE}`);
            console.log(`   Usuario: ${result.username}`);
            console.log(`   Credenciales en Keychain: ${result.remembered ? 'sí' : 'no'}`);
        } else {
            console.error('\n❌ El login no se completó.');
            process.exitCode = 1;
        }
    } finally {
        rl.close();
    }
}

function cmdStatus(): void {
    const session = loadSession();
    if (!looksAuthenticated(session)) {
        console.log('No hay sesión activa. Corre: bg-mcp login');
        process.exitCode = 1;
        return;
    }
    console.log(`Usuario:          ${session.username}`);
    console.log(`Login:            ${new Date(session.loggedInAt).toLocaleString()}`);
    console.log(`Última consulta:  ${new Date(session.lastVerifiedAt).toLocaleString()}`);
    console.log(`Keychain:         ${session.remembered ? 'sí' : 'no'}`);
    console.log(`Archivo:          ${SESSION_FILE}`);
}

async function cmdLogout(): Promise<void> {
    const session = loadSession();
    const cleared = clearSession();
    if (session?.username) await deleteCredentials(session.username);
    console.log(cleared ? 'Sesión eliminada.' : 'No había sesión que eliminar.');
}

function usage(): void {
    console.log(`bg-mcp — MCP de solo lectura para Banco General

Uso:
  bg-mcp login [--headless]   Inicia sesión (browser visible por defecto)
  bg-mcp status               Muestra el estado de la sesión guardada
  bg-mcp logout               Borra la sesión y las credenciales del Keychain
  bg-mcp serve                Arranca el servidor MCP en stdio

El servidor normalmente lo lanza tu cliente MCP con:
  node <ruta>/dist/index.js`);
}

async function main(): Promise<void> {
    const [command, ...rest] = process.argv.slice(2);
    switch (command) {
        case 'login':
            await cmdLogin(rest.includes('--headless'));
            break;
        case 'status':
            cmdStatus();
            break;
        case 'logout':
            await cmdLogout();
            break;
        case 'serve':
            await import('../index.js');
            break;
        default:
            usage();
            if (command) process.exitCode = 1;
    }
}

main().catch((err: unknown) => {
    console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
