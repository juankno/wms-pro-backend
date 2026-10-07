# WMS Pro — Plan de desarrollo

> Documento vivo. Fuente de verdad del roadmap para los tres repos.
> Última actualización: 2026-10-04.
> Al terminar una tarea, márcala `[x]` y actualiza la sección **Estado actual** al final.

## 1. Visión

WMS Pro se comercializará como **SaaS multiempresa (multi-tenant)** con las funcionalidades estándar de un WMS. No está hecho a medida de una sola empresa. Por eso:

- Todo dato pertenece a un tenant. Aislamiento con `tenantId` en cada tabla + Row-Level Security (RLS) de PostgreSQL.
- Las capacidades opcionales (lotes, series, vencimiento, unidades de medida múltiples, decimales, ubicaciones jerárquicas) son **configurables por tenant** mediante feature flags.
- El hardware es indiferente: cámara, pistola en modo teclado (keyboard-wedge) y Zebra DataWedge.
- Integraciones **abiertas** (API pública, webhooks, importación/exportación) en lugar de amarrarse a un ERP concreto.

## 2. Repositorios

| Repo | Ruta local | Stack |
|---|---|---|
| Backend | `C:\laragon\www\wms-pro-backend` (`github.com/juankno/wms-pro-backend`) | NestJS, Prisma 5, PostgreSQL 16 |
| Frontend web | `C:\laragon\www\wms-pro-frontend` | Next.js 16 (App Router), shadcn v4 (base-ui), TanStack Query, Zustand |
| App móvil | `C:\laragon\www\wms-pro` | Expo SDK 57, React Native 0.86, React Navigation 7 |

Puerto del backend en local: `.env` usa `PORT=3001` (el frontend apunta a `http://localhost:3001/v1`). La documentación de la API está en `/docs`.

## 3. Decisiones de arquitectura

| # | Decisión | Motivo |
|---|---|---|
| D1 | Multi-tenant con **BD compartida + `tenantId` + RLS**. No usar un esquema por tenant. | Las migraciones de Prisma no escalan a cientos de esquemas. RLS es la segunda barrera si una consulta olvida el filtro. Un plan enterprise con BD dedicada queda como opción futura. |
| D2 | `tenantId` se inyecta con una **extensión de Prisma Client** y viaja en el JWT. El tenant se resuelve por subdominio o por slug en el login. | Evita filtrar a mano en cada servicio. |
| D3 | Unicidades por tenant: `@@unique([tenantId, code])`, `@@unique([tenantId, username])`, etc. | Dos empresas pueden tener el mismo código de producto. |
| D4 | Los cambios de stock usan **operaciones atómicas** (`increment`/`decrement` condicionados o `SELECT … FOR UPDATE`) más `CHECK (stock >= 0)` en BD. | Hoy hay condiciones de carrera (lectura y luego escritura de valores absolutos). |
| D5 | Todo endpoint recibe **DTOs con class-validator**. Prohibidos los tipos inline en `@Body()`. | Los tipos inline no se validan (ValidationPipe los ignora). |
| D6 | Las operaciones móviles que se puedan reintentar llevan **`Idempotency-Key`**. | Requisito para el modo sin conexión. |
| D7 | Logging estructurado con Pino y trazas OpenTelemetry. | Diagnóstico por tenant en producción. |
| D8 | Código y comentarios en **inglés**, comentarios mínimos. Los textos que ve el usuario (mensajes de error de la API, Swagger, UI) siguen en español hasta implementar i18n en la Fase 8. La API siempre expone códigos de error estables en inglés (`WAREHOUSE_FORBIDDEN`, …). | Producto SaaS internacional; los clientes traducen a partir del código. |
| D9 | Los nombres del modelo de datos en español (`stockFisico`, `entrada_compra`, …) se renombran a inglés en la **Fase 1**, en la misma migración que agrega `tenantId`, como cambio de contrato coordinado (API v2) en los tres repos. | Tocar el esquema y el contrato una sola vez. |
| D10 | Tests con **Vitest + SWC** (NestJS 12 es solo ESM y Jest no lo carga). Integración contra una BD desechable (`TEST_DATABASE_URL`). Nunca se commitea con errores de compilación, lint o tests. | Calidad mínima exigible a cada PR. |
| D11 | El aislamiento por tenant se hace en la aplicación: `TenantInterceptor` + `AsyncLocalStorage` + un proxy del cliente de Prisma que inyecta `tenantId` **al construir** cada consulta (no al ejecutarla), y SQL crudo con filtro explícito. **RLS de PostgreSQL queda para antes de producción (Fase 8)**, con dos roles: `wms_app` (sin `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, `SET LOCAL app.tenant_id` por transacción) y `wms_system` (migraciones, login, refresh, consola de plataforma). | Un superusuario ignora RLS, y fijar la variable por consulta con el pool de Prisma duplica los viajes a la base. La capa de aplicación ya está cubierta por tests de aislamiento. |
| D12 | Las cantidades siguen siendo **enteras en la unidad base** del producto; los empaques se modelan como códigos de barras con cantidad por lectura (2.4). Las **series** (número por unidad) y las **cantidades decimales** quedan para después de la Fase 3. | Pasar a decimales toca todo el motor de stock, reservas y reportes; los casos de granel se cubren eligiendo una unidad base pequeña (gramos, mililitros). |
| D13 | **Trabajos en segundo plano en una tabla `jobs` propia sobre PostgreSQL** (sin Redis): los workers toman trabajos con `FOR UPDATE SKIP LOCKED`, recuperan los de un worker caído cuando vence su bloqueo y reintentan con espera exponencial. Importaciones grandes, generación de PDF, purga de eliminados y notificaciones corren como trabajos con estado, progreso, reintentos y reporte de errores. Cada instancia de la API ejecuta trabajos salvo `JOBS_WORKER=false`. | Ya usamos PostgreSQL. Se descartó `pg-boss`: su versión 12 solo funciona como módulo ES (el backend es CommonJS) y usa su propia conexión, así que no puede encolar dentro de la transacción de Prisma que guarda los datos. Una sola tabla con `tenantId` es también la que ve cada empresa. |
| D14 | **Importación por integración**: API con *API keys* por empresa (hash, scopes `products:write`, `stock:write`…, rotación, rate limit) y endpoints por lotes (`POST /integrations/v1/products/batch`, hasta 1000 filas, upsert por código e `Idempotency-Key`); lotes grandes se encolan y responden un `jobId`. Comparte el validador del CSV y luego se suman webhooks (Fase 7). | Más volumen que Excel, idempotente ante reintentos, seguro y auditable. |
| D15 | **Eliminación lógica** (`deletedAt`) para maestros y documentos, con filtro automático en el proxy de tenant, índices únicos parciales (`WHERE "deletedAt" IS NULL`) para reutilizar códigos y **purga física programada** tras un plazo configurable (90 días por defecto). Las líneas hijas siguen borrándose dentro de la transacción del padre. | Recuperación y trazabilidad; los borrados ya son transaccionales, así que el riesgo real es perder información, no corromperla. |
| D16 | **Documentos PDF desde plantillas HTML** (Handlebars) renderizadas con Chromium headless en un trabajo de D13 y guardadas en el almacenamiento de objetos; `pdfkit` se mantiene para etiquetas. Importaciones admiten CSV y XLSX (`exceljs`) en streaming. | Plantillas editables por empresa (logo, datos legales) sin bloquear la API. |
| D17 | **Integración con ERP mediante conectores** sobre un contrato común (datos maestros de entrada, documentos de salida, registro de sincronización). El ERP manda en maestros y pedidos; WMS Pro manda en la ejecución física y publica cada operación terminada como documento del ERP. El primer conector previsto es **SAP Business One vía Service Layer**; S/4HANA (APIs OData) sería un conector aparte. *Propuesta a futuro, fuera de las prioridades actuales.* | Integrarse con el ERP del cliente suele decidir la compra, y el contrato común evita amarrar el núcleo a un ERP concreto (Visión). |

## 4. Diagnóstico inicial (2026-10-04)

### Lo que ya funciona
- Auth JWT (access 1h y refresh 30d con rotación). Roles: operator, supervisor, admin.
- Catálogo de productos con fotos y un código de barras por producto. Stock por bodega con kardex (`StockMovement`, valores antes y después).
- Salida: orden de picking → reserva al recoger → packing con cajas → descuento del stock físico.
- Web: dashboard, CRUD completo, reportes, exportación CSV, gestión de usuarios y bodegas.
- Móvil: picking y packing con escaneo por cámara, fotos y consulta de productos.

### Lo que falta para un WMS completo
- **Maestros:** ubicaciones como entidad (hoy `location` es texto libre), clientes, proveedores, unidades de medida con conversiones, varios códigos de barras por producto, lotes/series/vencimiento, decimales, costo y valorización.
- **Entradas:** órdenes de compra, avisos de llegada (ASN), recepción, ubicación (putaway) y devoluciones. Hoy no existe nada.
- **Salidas:** pedido de venta separado del picking, reserva al liberar el pedido, picking en lote o por olas, ruta por ubicación, etiquetas, despacho, transportadora y guía.
- **Inventario:** conteos cíclicos, traslados con estado en tránsito, reabastecimiento, auditoría general.
- **Móvil:** soporte de escáneres industriales, escaneo continuo, modo sin conexión, push real, bandeja de tareas.
- **Plataforma:** multi-tenant, roles configurables, API pública, webhooks, cobro, onboarding, tests y CI.

### Fallos conocidos

**Backend**

- [x] B1. Tipos inline en `@Body()` (sin validación) en stock, picking, packing y warehouses. Un `ajuste_positivo` con cantidad negativa resta stock. `CreateMovementDto` y `TransferDto` existen pero no se usan.
- [x] B2. `stock.service.ts`: el tipo de movimiento manual no está restringido; `salida_picking` o `entrada_devolucion` se pueden registrar a mano.
- [x] B3. `stock.controller.ts` no tiene `RolesGuard` ni comprueba la bodega del usuario: cualquier operario ajusta o traslada en cualquier bodega. Lo mismo pasa con `?warehouseId=` en picking, packing, reportes, `users/warehouse/:id` y `activity/order/:id`.
- [x] B4. Un traslado no valida origen ≠ destino ni que el destino exista; con origen = destino crea o destruye stock.
- [x] B5. Condiciones de carrera: escritura de valores absolutos sin bloqueo, sin `CHECK >= 0`.
- [x] B6. Packing: al completar se descuenta `packedQuantity`, y si es menor que lo recogido la reserva sobrante nunca se libera. Cancelar un packing tampoco libera las reservas. Se puede completar sin empacar todo.
- [x] B7. Picking: se puede completar con 0 ítems recogidos. Al crear la orden no se reserva stock (sobreventa).
- [x] B8. `activity.log` se escribe con `this.prisma` en vez de `tx` (fuera de la transacción).
- [x] B9. Secretos: `main.ts` compara contra un texto que no coincide con los de ejemplo, el JWT usa `'secret'` como valor por defecto, y `JWT_REFRESH_*` y `MAX_FILE_SIZE_MB` no se usan (30 días hardcodeado).
- [x] B10. No se detecta la reutilización de refresh tokens, que además se guardan en texto plano.
- [x] B11. `ThrottlerModule` está configurado pero no hay `ThrottlerGuard` global.
- [x] B12. `/health` responde 200 aunque la BD esté caída.
- [x] B13. `products.service.ts`: el filtro `stockStatus` se aplica después de paginar, así que el `total` sale mal.
- [x] B14. `reports.service.ts` carga tablas enteras en memoria.
- [x] B15. `UpdateUserDto.active` no tiene `@IsBoolean`, y un admin puede desactivarse a sí mismo o dejar el sistema sin admin.
- [x] B16. Swagger documenta `traslado_entrada/salida`, pero el enum real es `entrada_traslado/salida_traslado`.
- [ ] B17. Uploads solo en disco local, sin procesar imágenes ni limpiar huérfanos.
- [x] B18. `NotificationsService` (Expo push) nunca se invoca.
- [x] B19. Falta un endpoint `/auth/me` (perfil y cambio de la contraseña propia).
- [x] B20. Docker: corre como root, sin HEALTHCHECK, sin `prisma migrate deploy`, con secretos hardcodeados en `docker-compose.yml`.
- [x] B21. Cero tests (no existe `test/jest-e2e.json`) y sin CI.

**Frontend web**

- [x] F1. Llama a `/stock/products/:id/movements`, pero la ruta real es `/products/:id/movements` (404): están rotos el ajuste manual y el historial del producto.
- [x] F2. Envía `limit` de 200, 500 y 10000, pero el backend permite como máximo 100 (400). Fallan los selectores de producto y la exportación CSV.
- [x] F3. El dashboard llama a `reports/*` (solo supervisor), así que el operario recibe 403. `/perfil` usa `PATCH /users/:id` (solo admin).
- [x] F4. No hay guard de rol por ruta: un operario puede entrar a `/usuarios`, `/bodegas` y `/reportes`.
- [x] F5. Los tokens se duplican en localStorage (claves sueltas y blob de Zustand) y se desincronizan al hacer refresh.
- [x] F6. Ninguna query maneja `isError`: un fallo se ve como una tabla vacía.
- [x] F7. Sin tests, sin Dockerfile, sin CI, sin `.env.example`.

**App móvil**

- [x] M1. No restaura la sesión al abrir: `AppNavigator.tsx:79` siempre empieza en Login.
- [x] M2. Si el refresh falla, las peticiones en cola (`refreshSubscribers`) quedan colgadas para siempre.
- [x] M3. `uploads.service.ts` no maneja 401/refresh.
- [x] M4. `AppContext` sigue cargando `mockData`, y las notificaciones locales salen de esos datos simulados.
- [x] M5. Aparece "¿Descartar cambios?" después de guardar con éxito (Create/Edit Picking, CreatePacking, ProductForm).
- [x] M6. ProductForm no envía `location`.
- [x] M7. Scanner: un escaneo hecho antes de que carguen los ítems se marca como "no pertenece", y las pantallas de detalle no se refrescan al volver.
- [x] M8. Los toggles de sonido y vibración no hacen nada.
- [x] M9. Las listas se truncan en 100 sin paginación.
- [x] M10. La referencia de la orden se genera en el cliente y puede repetirse.
- [x] M11. El push token nunca se registra. Se piden permisos innecesarios (RECORD_AUDIO, WRITE_EXTERNAL_STORAGE).
- [x] M12. Sin tests ni lint. Todo por HTTP plano.

## 5. Fases

Las estimaciones son gruesas, para 1–2 desarrolladores. **Primera versión vendible = fases 0, 1, 2, 3, 4 y 6 + cobro básico (≈ 4–5 meses).**

### Fase 0 — Estabilización (1–2 semanas)
- [x] 0.1 Backend: DTOs con class-validator en todos los endpoints (B1, B2, B15, B16).
- [x] 0.2 Backend: guards de rol y de alcance por bodega (B3).
- [x] 0.3 Backend: stock atómico, `CHECK >= 0`, validaciones de traslado, reservas correctas en picking y packing, log dentro de la transacción (B4–B8).
- [x] 0.4 Backend: seguridad y plataforma: secretos, throttler, health 503, refresh tokens hasheados con detección de reutilización, `/auth/me` (B9–B12, B19).
- [x] 0.5 Backend: paginación correcta en productos y reportes agregados en SQL (B13, B14).
- [x] 0.6 Backend: suite de tests (unitarios + e2e del flujo reserva → picking → packing → descuento) y CI (B21).
- [x] 0.7 Frontend: F1–F6.
- [x] 0.8 Móvil: M1–M9 y M11; eliminar la capa de datos simulados.
- [x] 0.9 Docker y CI en los tres repos (B20, F7, M12).

### Fase 1 — Base SaaS (3–4 semanas)
- [x] 1.0 Renombrar a inglés campos y enums del modelo (D9). Backend #11, web #4, móvil #3.
- [x] 1.1 Modelo `Tenant` (slug, plan, estado, configuración, feature flags) y `tenantId` en todas las tablas, con migración de los datos actuales a un tenant "default".
- [x] 1.2 Aislamiento por tenant en el cliente de Prisma (backend #12). RLS diferido a la Fase 8 (D11).
- [x] 1.3 Login por tenant (subdominio o slug) con el tenant en el JWT.
- [x] 1.4 Roles y permisos configurables por tenant (reemplazan el enum fijo) e invitación de usuarios por correo. Backend #17 y #18, web #6, móvil #5.
- [x] 1.5 Consola de super-admin de la plataforma: crear, suspender y entrar como soporte a un tenant, y métricas de uso. Backend #16 y #19 (sesión de soporte de 30 min y auditoría de la plataforma), web #7.
- [x] 1.6 Auditoría general (interceptor), por tenant. Backend #13.
- [x] 1.7 Almacenamiento S3-compatible con prefijo por tenant. Backend #14.
- [x] 1.8 Límites por plan (usuarios, bodegas, operaciones al mes). Backend #15.

### Fase 2 — Datos maestros configurables (3 semanas)
- [x] 2.1 Ubicaciones jerárquicas (bodega → zona → pasillo → estante → nivel → posición) con tipo y capacidad. Backend #20 (API y generación por niveles), web #8.
- [x] 2.2 Stock por ubicación (`LocationStock`), con migración desde `WarehouseStock.location`. Backend #22 (contador `picked`, reubicación, picking por ubicación), web #8, móvil #6.
- [x] 2.3 Clientes y proveedores. Backend #23, web #9.
- [ ] 2.4 Unidades de medida con conversiones y varios códigos de barras por producto. Backend #24, web #9, móvil #7: códigos adicionales con cantidad por lectura (empaques). Conversión entre unidades en órdenes pendiente.
- [x] 2.5 Lotes, series y vencimiento (activables por tenant y por producto). Cantidades decimales. Backend #26, web #10, móvil #8: lotes con vencimiento, FEFO y trazabilidad; series y decimales diferidos (D12).
- [x] 2.6 Campos personalizados por tenant. Backend #31, web #12 (productos, clientes/proveedores y ubicaciones).
- [x] 2.7 Importación masiva Excel/CSV (productos, ubicaciones, stock inicial) e impresión de etiquetas. Backend #25 y #29 (etiquetas PDF y ZPL), web #10 y #12.

### Fase 3 — Entradas (3 semanas)
- [x] 3.1 Órdenes de compra. Backend #27 y #32, web #11.
- [ ] 3.2 Avisos de llegada (ASN).
- [x] 3.3 Recepción (ciega o contra la orden) con escaneo y diferencias. Backend #28 y #32, web #11, móvil #9.
- [ ] 3.4 Putaway con reglas configurables. Backend #28: sugerencia "donde ya está el producto y hay capacidad"; faltan reglas configurables.
- [x] 3.5 Devoluciones (RMA). Backend #33, web #13 (sobre la recepción: reingreso o descarte, límite contra lo despachado).
- [ ] 3.6 Flujos móviles de recepción y putaway.

### Fase 4 — Salidas (4 semanas)
- [x] 4.1 Pedido de venta → asignación y reserva → tareas de picking. Backend #35, web #14.
- [x] 4.2 Picking por pedido, en lote o por olas, con ruta por ubicación. Backend #36, web #14, móvil #10.
- [x] 4.3 Estrategias FIFO, FEFO y LIFO configurables. Backend #37, web #15 (por empresa y por producto, sobre lotes).
- [x] 4.4 Packing con contenido por caja y etiquetas ZPL/PDF. Backend #38, web #15 (etiqueta de envío por caja).
- [x] 4.5 Despacho, transportadora, guía y prueba de entrega. Backend #38, web #15; falta la entrega desde el móvil.
- [x] 4.6 Referencias generadas en el backend con secuencias por tenant (M10). Backend #34, web #13.

### Fase 5 — Control de inventario (2–3 semanas)
- [x] 5.1 Conteos cíclicos con aprobación de diferencias. Backend #39, web #19, móvil #13.
- [x] 5.2 Traslados con estado en tránsito y recepción en el destino. Backend #40, web #19, móvil #13.
- [ ] 5.3 Reabastecimiento por mínimo y máximo.
- [ ] 5.4 Notificaciones push y por correo reales (B18).

### Fase 5.5 — Plataforma de procesos y documentos (2–3 semanas)
- [x] 5.5.1 Trabajos en segundo plano (D13): tabla de trabajos visible por empresa, progreso, reintentos y reporte de errores. Primer trabajo: verificación de integridad del stock.
- [ ] 5.5.2 Importación asíncrona CSV/XLSX sobre la cola, con plantillas por tipo y archivo de errores (D16).
- [ ] 5.5.3 API de integración con API keys, scopes, lotes idempotentes y límites por plan (D14; adelanta parte de 7.1).
- [ ] 5.5.4 Eliminación lógica y purga programada (D15).
- [ ] 5.5.5 Documentos PDF: lista de picking, nota de despacho/remisión, acta de recepción, hoja de conteo y orden de compra, con marca de la empresa (D16).

### Fase 6 — Móvil industrial (2–3 semanas, en paralelo con las fases 3–5)
- [ ] 6.1 Escaneo por cámara, keyboard-wedge y DataWedge, en modo continuo.
- [ ] 6.2 Bandeja "mis tareas".
- [ ] 6.3 Modo sin conexión con cola de operaciones e `Idempotency-Key`.
- [ ] 6.4 Builds firmados con HTTPS y autoincremento de versión.

### Fase 7 — Integraciones abiertas (3 semanas)
- [ ] 7.1 API pública versionada con API keys y scopes.
- [ ] 7.2 Webhooks (pedido despachado, stock bajo, recepción completada…).
- [ ] 7.3 Portal de documentación para desarrolladores.
- [ ] 7.4 Primeros conectores (Shopify, WooCommerce, Siigo o Alegra, según demanda).

### Fase 8 — Comercialización (3–4 semanas)
- [ ] 8.1 Cobro de suscripciones (Stripe, o Wompi o Mercado Pago), con prueba gratuita y planes.
- [ ] 8.2 Registro de nuevos clientes y asistente de configuración inicial.
- [ ] 8.3 Idiomas (es/en/pt), moneda y zona horaria por tenant.
- [ ] 8.4 Legal: términos, Ley 1581 (Habeas Data), acuerdo de tratamiento de datos (DPA).
- [ ] 8.5 Copias de seguridad y restauración por tenant, monitoreo y SLA.

### Propuestas a futuro (fuera de prioridad)

Ideas evaluadas y aceptadas como dirección del producto, sin fecha. Se priorizan cuando haya un cliente piloto o demanda concreta.

**F1 — Sincronización con SAP Business One (Service Layer)** (D17; estimado 4–6 semanas; requiere 5.5.1, 5.5.3 y 7.2)
- [ ] F1.1 Contrato de conector ERP: configuración cifrada por empresa, mapeo de almacenes, series y campos, y registro de sincronización con reenvío.
- [ ] F1.2 Entrada desde SAP: artículos, socios de negocio, almacenes, órdenes de compra y pedidos de venta. Service Layer no avisa los cambios, así que se consultan periódicamente por fecha y hora de actualización, leyendo por páginas.
- [ ] F1.3 Salida hacia SAP: recepción → entrada de mercancía (`PurchaseDeliveryNotes`), despacho → entrega (`DeliveryNotes`), devolución (`Returns`), traslado (`StockTransfers`) y ajustes de conteo (`InventoryGenEntries`/`InventoryGenExits`), con los lotes como `BatchNumbers`.
- [ ] F1.4 Confiabilidad: cada envío es un trabajo de D13 con reintentos; se guarda el `DocEntry` de SAP en el documento de WMS Pro y el id de WMS Pro en un campo de usuario de SAP, para no duplicar documentos al reintentar. Sesión de Service Layer reutilizada (vence a los 30 minutos) y envíos agrupados con `$batch`.
- [ ] F1.5 Conectividad: Service Layer suele estar en el servidor del cliente, detrás de su firewall. Piloto con Service Layer publicado por HTTPS y lista de IPs permitidas; a escala, un agente liviano en el servidor del cliente que solo hace conexiones de salida.
- Pendiente de definir: versión y base de datos de SAP del primer cliente, base de pruebas de SAP para desarrollar, licencia del usuario de integración, y si SAP maneja ubicaciones (se recomienda que SAP lleve el stock por almacén y WMS Pro el detalle por ubicación).

## 6. Estado actual

- **Fases 0, 1, 2 y 4 completas** (la entrega desde el móvil de la Fase 4 sigue pendiente).
- **Fase 3 en curso:** 3.1, 3.3 y 3.5 (API) listas; 3.4 con sugerencia simple; 3.2 (ASN) y 3.6 (putaway móvil) pendientes.
- **Fase 5 en curso:** 5.1 (conteos) y 5.2 (traslados) completos con API, web y móvil (la app cuenta escaneando y recibe traslados; crear y aprobar se hace en la web); 5.3 y 5.4 pendientes.
- **Todo mergeado a `main` (2026-10-06):** backend hasta #46, web hasta #19, móvil hasta #13. No quedan ramas abiertas.
- **CI deshabilitado** a pedido del usuario (`gh workflow disable`); la garantía es la verificación local (lint, typecheck, tests y build) antes de cada commit. Los workflows siguen en el repo.
- **Datos de demostración:** `npm run prisma:seed` (idempotente) y `npm run db:check` para revisar los invariantes de stock. Usuarios `admin/admin123`, `supervisor/sup123`, `operario/op123`.
- **Fotos:** con almacenamiento local la API guarda URLs relativas (`/v1/uploads/...`) y cada cliente las completa con su URL de API; `PUBLIC_URL` ya no se usa.
- **Variables:** `STORAGE_DRIVER`/`S3_*`, `MAIL_DRIVER`, `SMTP_URL`, `MAIL_FROM`, `APP_URL`. Ver `.env.example`.
- **Siguiente tarea:** Fase 5.5 empezando por la cola de trabajos (5.5.1); luego 5.3 (reabastecimiento) y 5.4 (notificaciones).
- **Propuestas a futuro:** F1 (sincronización con SAP Business One), sin fecha.
- **Base de pruebas:** `TEST_DATABASE_URL` → `wms_pro_test` (desechable).
