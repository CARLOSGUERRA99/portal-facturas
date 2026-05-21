# Migración Gasmaz → Engine declarativo

## Estado actual

| Componente | Estado | Archivo |
|------------|--------|---------|
| config.json | ✅ Creado | commerce/gasmaz/config.json |
| selectors.json | ✅ Creado | commerce/gasmaz/selectors.json |
| flow.json | ✅ Creado | commerce/gasmaz/flow.json |
| hooks.js | ✅ Creado | commerce/gasmaz/hooks.js |
| Engine integrado en router | ✅ | bots/index.js (engine va primero) |
| Bot legacy | ✅ Intacto | bots/gasmaz.js (fallback) |
| Test local | ✅ Creado | scripts/test-gasmaz.js |
| Test real exitoso | ⏳ Pendiente | — |
| Commit | ⏳ Pendiente | — |

---

## Qué ya migró al engine

### Declarativo en flow.json
- `goto` — navega a url_base o portalUrl si coincide con dominio
- `waitFor #txtReferencia` — confirma que el portal cargó
- `fill` × 4 campos — referencia, folio, total, rfc (strategy: keyboard)
- `click #btnNext` — botón Buscar
- `waitForAny` — detecta paso2 (normal) vs ya_facturado
- `on/exit` — manejo del caso ya_facturado
- `fill` × 2 — razonSocial, email
- `waitForAny` — detecta descarga vs error tras facturar
- `on/exit` — manejo del caso error

### En hooks.js (lógica que no puede ser JSON)

| Hook | Por qué está en hook | Cuándo migrar |
|------|---------------------|---------------|
| `seleccionarRegimen` | `selectByText` no existe aún como action | Cuando se cree `actions/selectByText.js` |
| `seleccionarCfdi` | Ídem + espera AJAX (`options.length > 1`) | Cuando se cree `actions/waitForCondition.js` |
| `seleccionarFormaPago` | `selectByText` no existe aún | Cuando se cree `actions/selectByText.js` |
| `clickFacturar` | Botón sin selector fijo, se busca por texto | Cuando se cree `actions/clickText.js` |
| `descargarArchivos` | URLs construidas desde hrefs + fetch con cookies | Permanece en hook (lógica muy específica de Gasmaz) |
| `descargarExistente` | Variante del ya_facturado | Permanece en hook |

---

## Qué sigue dependiendo del legacy

- `bots/gasmaz.js` — se mantiene como fallback automático en `bots/index.js`
- Si el engine falla (retorna null o lanza excepción no capturada), el router cae al legacy
- El legacy tiene su propia lógica de `referencia` (usa `datos.referencia`, el engine usa `datos.folio`)
  → **Riesgo**: verificar que el payload que llega tiene `folio` y no solo `referencia`

---

## Riesgos conocidos

### Riesgo 1 — Campo `referencia` vs `folio`
El bot legacy recibe `referencia` como campo separado. El flow.json actual usa `{{folio}}` para ambos campos (`#txtReferencia` y `#txtFolio`). Verificar con el OCR qué campo extrae realmente.

**Mitigación**: en `buildContext()` agregar:
```js
referencia: String(datos.referencia || datos.folio || ''),
```
Y en flow.json usar `{{referencia}}` para `#txtReferencia`.

### Riesgo 2 — CFDI keywords en config.json
El mapeo de `G03 → "Gastos en general"` está en `config.json`. Si el portal actualiza los textos de las opciones, hay que actualizar solo `config.json`, no el código.

### Riesgo 3 — URL del portal
Gasmaz tiene múltiples subdominios (redmaxfactura.nexusfuel.mx, gasmaz.nexusfuel.mx, etc.). El `portalUrl` del OCR puede apuntar a cualquiera. El `buildContext()` actual acepta cualquier URL que contenga `nexusfuel.mx`. Si el dominio cambia, actualizar `config.dominio`.

### Riesgo 4 — `page.browser()` en hooks.js
`descargarArchivos` llama a `page.browser()` para abrir nueva pestaña para el PDF. Si Browserless cierra la sesión entre steps, esto falla. Es el mismo riesgo que en el bot legacy.

---

## Cómo hacer rollback inmediato

Si el engine falla en producción, el rollback es automático — `bots/index.js` detecta el error y cae al bot legacy. No se necesita deploy.

Para deshabilitar el engine completamente sin deploy:
1. En Railway, agregar variable: `ENGINE_DISABLED=true`
2. En `bots/index.js`, envolver la llamada al engine:
```js
if (portal && tieneEngine(portal) && process.env.ENGINE_DISABLED !== 'true') {
```

Para deshabilitar solo Gasmaz del engine, borrar `commerce/gasmaz/flow.json` y hacer deploy.

---

## Cómo correr el test local

```bash
# Con valores en .env
RFC="TURF123456789" FOLIO="12345" TOTAL="500.00" node scripts/test-gasmaz.js

# O editando directamente el PAYLOAD en el script
node scripts/test-gasmaz.js
```

Logs esperados en una ejecución exitosa:
```
[ENGINE][gasmaz][TEST-xxx] buildContext: { portal: 'gasmaz', url: 'https://...', ... }
[ENGINE][gasmaz][TEST-xxx] validateContext: todos los placeholders resuelven OK
[ENGINE][gasmaz][TEST-xxx] Abriendo browser (stealth: true)
[ENGINE][gasmaz][TEST-xxx] flow_start { steps: 18 }
[ENGINE][gasmaz][TEST-xxx] [step 00] goto — 4231ms
[ENGINE][gasmaz][TEST-xxx] [step 01] waitFor — 312ms
...
[ENGINE][gasmaz][TEST-xxx] [hook] → seleccionarRegimen()
...
[ENGINE][gasmaz][TEST-xxx] RESULTADO: { ok: true, xmlUrl: '...', pdfUrl: '...' }
```

---

## Próximos pasos después del test exitoso

1. Commit limpio con mensaje: `feat: engine declarativo — migración Gasmaz (fase 1)`
2. Crear `actions/selectByText.js` y mover hooks de selección al flow.json
3. Migrar siguiente portal: Rendichicas (AngularJS — similar complejidad)
4. Migrar ARCO/BuzonFacturas
5. Evaluar si `descargarArchivos` puede convertirse en action `download` genérica
