/**
 * Los archivos que repiten la versión de package.json. Ninguno la hereda, así
 * que viven listados aquí y los recorren tanto el sincronizador como el
 * chequeo de CI.
 */

import { readFileSync } from 'node:fs';

export const MANIFESTS = [
    { label: '.claude-plugin/plugin.json', url: new URL('../.claude-plugin/plugin.json', import.meta.url) },
    { label: 'manifest.json', url: new URL('../manifest.json', import.meta.url) },
];

export function packageVersion() {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}
