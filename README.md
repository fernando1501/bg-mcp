# bg-mcp

Servidor **MCP (stdio) de solo lectura** para la Zona Segura de Banco General.

Expone tus cuentas, tarjetas y pensión a un cliente MCP (Claude Code, Claude
Desktop, etc.) para poder preguntar cosas como *"¿cuánto gasté en julio?"* o
*"búscame ese cargo de $250"*, sin que el servidor pueda mover un centavo.

---

## Garantía de solo lectura

No es solo que no existan tools de transferencia. Hay tres capas, todas en
[`src/http/guard.ts`](src/http/guard.ts):

1. **Allowlist explícita.** Cada request pasa por `assertReadOnly(method, path)`
   antes de que axios lo vea. Si la ruta no está en la lista, la petición nunca
   sale del proceso. Ojo: varios endpoints de *lectura* de BG son POST (`find`,
   `state`, `statement`), así que filtrar por verbo no sirve — el match es por
   ruta exacta y anclada.
2. **Blocklist de mutación.** Se evalúa primero y rechaza sin importar la
   allowlist: `/api/jsonws/invoke` (el RPC genérico de Liferay, que llega a
   cualquier servicio), transferencias, pagos, `pay-card`, reportes de tarjeta,
   edición de cuentas.
3. **Nunca se manda token CSRF.** Los endpoints de Liferay que cambian estado
   exigen `x-csrf-token`. Este cliente jamás lo adjunta, así que aunque las dos
   capas anteriores fallaran, el banco rechazaría la operación del lado del
   servidor.

Además, ningún tool recibe una ruta ni un body crudo del modelo: cada función de
`src/api/` construye el suyo a partir de argumentos validados con zod.

`npm test` incluye pruebas negativas que fallan la build si una ruta de escritura
pasa el guard.

---

## Instalación

Es un servidor **stdio**: corre local, lo lanza tu cliente MCP y hablan por
stdin/stdout. No hay nada que desplegar ni puerto que abrir. Elige según tu
cliente.

### Claude Desktop

Descarga `bg-mcp.mcpb` del [último release][releases] y ábrelo. Claude Desktop
lo instala como extensión: no hay JSON que editar ni dependencias que instalar,
el bundle las trae adentro.

[releases]: https://github.com/fernando1501/bg-mcp/releases/latest

### Claude Code

```bash
claude mcp add bg --scope user -- npx -y bg-mcp
```

`npx` baja el paquete la primera vez, lo cachea y lo ejecuta.

### A mano

Cualquier cliente que acepte un comando stdio:

```json
{
  "mcpServers": {
    "bg": { "command": "npx", "args": ["-y", "bg-mcp"] }
  }
}
```

No hay que configurar credenciales en ningún archivo — se piden al momento de
iniciar sesión.

### Chromium, el único paso que queda manual

El login maneja la UI real de Banco General, así que hace falta un Chromium de
Playwright (~150 MB). No viaja en el `.mcpb` ni lo instala el bundle — vive en
una caché compartida de la máquina, así que se baja una sola vez:

```bash
npx playwright install chromium
```

Si te lo saltas, Playwright lo dice explícitamente al intentar el primer login.

Instalando por `npx` hay un matiz extra: el postinstall de Playwright lo
descarga solo, pero si eso ocurre mientras el cliente MCP espera el primer
handshake puede pasarse del timeout y marcar el servidor como caído. Correr
`npx -y bg-mcp login` antes de registrarlo calienta la caché y de paso te deja
logueado.

### Instalación global

Si prefieres no depender de la caché de npx:

```bash
npm i -g bg-mcp
claude mcp add bg --scope user -- bg-mcp
```

### Como plugin de Claude Code

El paquete también trae un [`.claude-plugin/`](.claude-plugin/), por si lo
quieres administrar como plugin (`/plugin update`, activar y desactivar) en vez
de como servidor MCP suelto. Son dos comandos en lugar de uno, porque en Claude
Code todo plugin se instala desde un marketplace:

```
/plugin marketplace add fernando1501/bg-mcp
/plugin install bg-mcp@bg-mcp
```

El marketplace solo hospeda el índice; el plugin se baja de npm
(`"source": "npm"`), así que no hay repo que clonar ni `dist/` que versionar.
Chromium sigue siendo aparte: Claude Code instala las dependencias del plugin
con `--ignore-scripts`, o sea el postinstall de Playwright no corre.

### Desde el código

```bash
git clone https://github.com/fernando1501/bg-mcp.git && cd bg-mcp
npm install
npx playwright install chromium
npm run build
claude mcp add bg --scope user -- node "$PWD/dist/index.js"
```

---

## Login

El login de Banco General son tres pantallas y **la pregunta de seguridad es
dinámica**: la elige el banco y cambia por cuenta. Por eso el flujo son tres
tools encadenados, y el servidor no sabe ni asume ninguna respuesta.

1. `bg_login_start({ username })` → devuelve la pregunta de seguridad que BG
   pidió, tal cual.
2. La AI te muestra esa pregunta y te pide la respuesta y la contraseña.
3. `bg_login_answer({ loginId, answer, password })` → sesión lista.
4. Si BG manda un código de un solo uso: `bg_login_otp({ loginId, code })`.

La sesión queda en `~/.bg-mcp/session.json` (permisos `600`, directorio `700`) y
guarda **solo cookies** — nunca la contraseña ni la respuesta de seguridad.

Mientras el servidor corre, hace un ping de lectura cada 10 minutos para que
Liferay no expire la sesión por inactividad.

### Mantener la sesión entre reinicios

`bg_login_answer` acepta `remember: true`, que guarda las credenciales en el
**Keychain de macOS** (`security add-generic-password`) para poder re-loguear
solo cuando el banco expire la sesión. Está apagado por defecto. `bg_logout`
borra sesión y entrada del Keychain.

### CLI de respaldo

Si el dispositivo no está registrado o BG pide OTP repetidamente, el flujo
headless puede no completar. Para eso:

```bash
npx -y bg-mcp login      # abre un browser visible
npx -y bg-mcp status
npx -y bg-mcp logout
```

Escribe el mismo archivo de sesión que consume el servidor.

---

## Tools

### Sesión
| Tool | Qué hace |
|---|---|
| `bg_session_status` | ¿Hay sesión? ¿de quién? ¿qué tan fresca? Llamar antes de pedir credenciales |
| `bg_login_start` | Paso 1: usuario → devuelve la pregunta de seguridad |
| `bg_login_answer` | Paso 2: respuesta + contraseña → sesión (o `otp_required`) |
| `bg_login_otp` | Paso 3: código de un solo uso, si aplica |
| `bg_logout` | Borra sesión y credenciales guardadas |

### Datos
| Tool | Qué hace |
|---|---|
| `bg_list_accounts` | Todos los productos con saldos y el `portalId` que usan los demás tools. **Empieza aquí** |
| `bg_get_account` | Detalle de un producto; despacha según sea ahorro, tarjeta o pensión |
| `bg_list_transactions` | Movimientos de una cuenta de ahorro por rango de fechas (paginación interna) |
| `bg_list_card_transactions` | Cargos y pagos de una tarjeta por período de estado de cuenta |
| `bg_get_card_statement` | Estado de cuenta: saldo, pago mínimo, fechas de corte y pago, planes |
| `bg_get_card_categories` | Desglose por categoría **según el banco** (Comida, Transporte, …) |
| `bg_get_pension` | Saldos y estado mensual del fondo Pro-Futuro |

### Analítica
| Tool | Qué hace |
|---|---|
| `bg_search_transactions` | Busca en **todas** las cuentas y tarjetas a la vez por texto, monto, tipo y fechas |
| `bg_spending_summary` | Resumen de un mes: ingresos, gastos, neto, desglose por cuenta y mayores gastos |

---

## Notas sobre los datos

- **Todas las fechas son hora de Panamá** (UTC-5, sin horario de verano). BG
  entrega epochs UTC; sin el corrimiento, un movimiento de las 23:30 aparecería
  al día siguiente y descuadraría cualquier total de fin de mes.
- **Los saldos son al `lastSyncDate` del banco**, no del momento exacto.
- **Un período de estado de cuenta no es un mes calendario** — empieza en la
  fecha de corte anterior. `bg_list_card_transactions` acepta `clampToMonth`
  para recortar al mes calendario.
- **Las transferencias entre cuentas propias aparecen de los dos lados** y
  `bg_spending_summary` no las excluye. Revisa las descripciones (p. ej.
  `ENTRE CUENTAS`) antes de leer los totales como flujo de caja neto.

## Variables de entorno

Solo una, opcional: `BG_MCP_HOME` cambia dónde vive el archivo de sesión
(por defecto `~/.bg-mcp`).

## Desarrollo

```bash
npm run build      # compila a dist/
npm test           # guard + normalización (sin red)
npm run inspect    # MCP Inspector contra el servidor compilado
npm run bundle     # arma build/bg-mcp.mcpb para Claude Desktop
```

`npm run bundle` monta un directorio aparte con `dist/`, el
[`manifest.json`](manifest.json) y solo las dependencias de producción, y lo
empaqueta con el CLI de `@anthropic-ai/mcpb`. Tiene que ser autocontenido porque
Claude Desktop descomprime el bundle y ejecuta `node dist/index.js` sin instalar
nada.

### Publicar

Publica GitHub Actions al empujar un tag de versión:

```bash
npm version patch      # sube package.json y arrastra plugin.json
git push --follow-tags
```

El workflow ([`.github/workflows/publish.yml`](.github/workflows/publish.yml))
corre las pruebas, verifica que `package.json`, los manifiestos y el tag digan la
misma versión, publica a npm, y arma el `.mcpb` y lo cuelga del release de
GitHub.

Necesita un secreto `NPM_TOKEN` en el repo (Settings → Secrets and variables →
Actions). Que sea un **granular access token** de npm, limitado al paquete
`bg-mcp` y con permiso de escritura — no un token clásico de cuenta, que puede
publicar cualquier cosa a tu nombre. Se puede prescindir del secreto
configurando *trusted publishing* en npmjs.com, que autentica por OIDC contra
este repo y este workflow.

Para publicar a mano el flujo sigue siendo `npm publish`.

#### Las versiones y el lockfile

La versión vive repetida en tres archivos y ninguno la hereda de otro. El hook
`version` de npm corre [`scripts/sync-version.mjs`](scripts/sync-version.mjs),
que la copia a [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) y a
[`manifest.json`](manifest.json) y los deja en el mismo commit;
[`scripts/check-version.mjs`](scripts/check-version.mjs) vuelve a comprobarlo en
CI por si alguien editó a mano. La lista está en
[`scripts/manifests.mjs`](scripts/manifests.mjs) — un archivo nuevo que repita la
versión se agrega ahí. La que reporta el servidor en
[`src/index.ts`](src/index.ts) sigue suelta, pero solo se ve en el handshake MCP.

`prepublishOnly` copia `package-lock.json` a `npm-shrinkwrap.json` y
`postpublish` lo borra. El rodeo existe porque npm excluye `package-lock.json`
de lo que publica, y Claude Code solo le instala dependencias a un plugin si
encuentra un lockfile **dentro del paquete**. Copiarlo al vuelo deja el repo con
un solo lockfile en vez de dos.

Efecto secundario a tener presente: un shrinkwrap publicado le fija el árbol de
dependencias a todo el que instale el paquete, no solo a quien lo use como
plugin. Los parches de `axios` o `playwright` le llegan a la gente cuando
republiques, no antes.
