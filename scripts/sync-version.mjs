#!/usr/bin/env node
/**
 * Corre desde el hook `version` de npm: `npm version patch` ya subió
 * package.json y todavía no ha hecho el commit, así que este es el momento de
 * arrastrar la misma versión al manifiesto del plugin y dejarla en el mismo
 * commit. Sin esto habría que acordarse a mano cada release, y el plugin
 * quedaría diciendo una versión distinta a la que npm instala.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const PLUGIN_MANIFEST = new URL('../.claude-plugin/plugin.json', import.meta.url);

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const source = readFileSync(PLUGIN_MANIFEST, 'utf8');
const manifest = JSON.parse(source);

if (manifest.version === version) {
    console.log(`plugin.json ya estaba en ${version}.`);
    process.exit(0);
}

// Reemplazo textual en vez de reescribir el JSON: conserva el orden de las
// claves y el formato del archivo tal como está.
const updated = source.replace(
    /("version"\s*:\s*)"[^"]*"/,
    (_match, prefix) => `${prefix}"${version}"`,
);

if (JSON.parse(updated).version !== version) {
    console.error('No se pudo actualizar la versión en .claude-plugin/plugin.json.');
    process.exit(1);
}

writeFileSync(PLUGIN_MANIFEST, updated);
console.log(`plugin.json: ${manifest.version} → ${version}`);
