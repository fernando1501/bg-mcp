#!/usr/bin/env node
/**
 * Corre desde el hook `version` de npm: `npm version patch` ya subió
 * package.json y todavía no ha hecho el commit, así que este es el momento de
 * arrastrar la misma versión a los manifiestos que la repiten y dejarlos en el
 * mismo commit. Sin esto habría que acordarse a mano cada release, y tanto el
 * plugin como el bundle quedarían anunciando una versión distinta a la real.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { MANIFESTS, packageVersion } from './manifests.mjs';

const version = packageVersion();

for (const { label, url } of MANIFESTS) {
    const source = readFileSync(url, 'utf8');

    if (JSON.parse(source).version === version) {
        console.log(`${label}: ya estaba en ${version}.`);
        continue;
    }

    // Reemplazo textual en vez de reescribir el JSON: conserva el orden de las
    // claves y el formato del archivo tal como está.
    const updated = source.replace(/("version"\s*:\s*)"[^"]*"/, (_match, prefix) => `${prefix}"${version}"`);

    if (JSON.parse(updated).version !== version) {
        console.error(`No se pudo actualizar la versión en ${label}.`);
        process.exit(1);
    }

    writeFileSync(url, updated);
    console.log(`${label}: → ${version}`);
}
