#!/usr/bin/env node
/**
 * Las tres versiones tienen que coincidir antes de publicar: la del paquete, la
 * del manifiesto del plugin y la del tag que disparó el workflow. Ninguna se
 * hereda de otra — `npm version` solo toca package.json — así que sin este
 * chequeo se publica un plugin que dice ser una versión distinta a la que
 * realmente instala npm.
 */

import { readFileSync } from 'node:fs';

const read = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));

const pkg = read('../package.json').version;
const plugin = read('../.claude-plugin/plugin.json').version;
const ref = process.env.GITHUB_REF_NAME ?? '';
const tag = ref.replace(/^v/, '');

const problems = [];
if (pkg !== plugin) {
    problems.push(`package.json dice ${pkg} y .claude-plugin/plugin.json dice ${plugin}`);
}
if (tag && tag !== pkg) {
    problems.push(`el tag ${ref} no corresponde a la versión ${pkg}`);
}

if (problems.length > 0) {
    console.error(`Versiones desalineadas:\n  - ${problems.join('\n  - ')}`);
    process.exit(1);
}

console.log(`Versión ${pkg} coherente en package.json, plugin.json${tag ? ' y el tag' : ''}.`);
