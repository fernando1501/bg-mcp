#!/usr/bin/env node
/**
 * Todas las versiones tienen que coincidir antes de publicar: la del paquete,
 * la de cada manifiesto que la repite y la del tag que disparó el workflow.
 * `npm version` solo toca package.json y el hook `version` arrastra el resto,
 * así que esto es la red por si alguien editó a mano.
 */

import { readFileSync } from 'node:fs';

import { MANIFESTS, packageVersion } from './manifests.mjs';

const pkg = packageVersion();

// GITHUB_REF_NAME es el nombre del ref, no necesariamente un tag: en un
// workflow_dispatch sobre una rama vale `main`. Solo hay tag que comparar
// cuando el disparo vino de uno.
const ref = process.env.GITHUB_REF_NAME ?? '';
const isTag =
    process.env.GITHUB_REF_TYPE === 'tag' || (process.env.GITHUB_REF ?? '').startsWith('refs/tags/');
const tag = isTag ? ref.replace(/^v/, '') : '';

const problems = [];

for (const { label, url } of MANIFESTS) {
    const found = JSON.parse(readFileSync(url, 'utf8')).version;
    if (found !== pkg) {
        problems.push(`package.json dice ${pkg} y ${label} dice ${found}`);
    }
}

if (tag && tag !== pkg) {
    problems.push(`el tag ${ref} no corresponde a la versión ${pkg}`);
}

if (problems.length > 0) {
    console.error(`Versiones desalineadas:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
}

console.log(
    `Versión ${pkg} coherente en package.json, ${MANIFESTS.map((m) => m.label).join(', ')}${tag ? ' y el tag' : ''}.`,
);
