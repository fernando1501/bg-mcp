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

```bash
cd ~/personal/bg-mcp
npm install
npx playwright install chromium   # el login se hace manejando la UI real
npm run build
```

## Registro en el cliente MCP

```bash
claude mcp add bg --scope user -- node ~/personal/bg-mcp/dist/index.js
```

O a mano, en la config de Claude Desktop:

```json
{
  "mcpServers": {
    "bg": { "command": "node", "args": ["/Users/TU_USUARIO/personal/bg-mcp/dist/index.js"] }
  }
}
```

No hay que configurar credenciales en ningún archivo — se piden al momento de
iniciar sesión.

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
node dist/cli/bin.js login      # abre un browser visible
node dist/cli/bin.js status
node dist/cli/bin.js logout
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
```

Este servidor nació de la automatización de presupuesto en
`~/personal/automations/automations/budget`, de donde vienen el flujo de login,
la paginación por cursor `seqNumber` y el manejo de zona horaria — todos ya
probados contra la API real.
