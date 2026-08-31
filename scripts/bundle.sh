#!/usr/bin/env bash
# Arma el .mcpb que Claude Desktop instala de un clic.
#
# El bundle tiene que ser autocontenido: Claude Desktop lo descomprime y ejecuta
# `node dist/index.js` sin instalar nada, así que las dependencias de producción
# viajan adentro.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$ROOT/build/mcpb"
OUT="$ROOT/build/bg-mcp.mcpb"

cd "$ROOT"
npm run build

rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -R dist "$STAGE/dist"
cp manifest.json package.json package-lock.json README.md "$STAGE/"

# Solo dependencias de producción, y sin lifecycle scripts: el postinstall de
# Playwright bajaría Chromium en la máquina que empaqueta, que no es donde hace
# falta.
(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --silent)

npx -y @anthropic-ai/mcpb@2.1.2 pack "$STAGE" "$OUT"
