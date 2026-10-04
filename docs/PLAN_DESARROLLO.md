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

- [ ] B1. Tipos inline en `@Body()` (sin validación) en stock, picking, packing y warehouses. Un `ajuste_positivo` con cantidad negativa resta stock. `CreateMovementDto` y `TransferDto` existen pero no se usan.
- [ ] B2. `stock.service.ts`: el tipo de movimiento manual no está restringido; `salida_picking` o `entrada_devolucion` se pueden registrar a mano.
- [ ] B3. `stock.controller.ts` no tiene `RolesGuard` ni comprueba la bodega del usuario: cualquier operario ajusta o traslada en cualquier bodega. Lo mismo pasa con `?warehouseId=` en picking, packing, reportes, `users/warehouse/:id` y `activity/order/:id`.
- [ ] B4. Un traslado no valida origen ≠ destino ni que el destino exista; con origen = destino crea o destruye stock.
- [ ] B5. Condiciones de carrera: escritura de valores absolutos sin bloqueo, sin `CHECK >= 0`.
- [ ] B6. Packing: al completar se descuenta `packedQuantity`, y si es menor que lo recogido la reserva sobrante nunca se libera. Cancelar un packing tampoco libera las reservas. Se puede completar sin empacar todo.
- [ ] B7. Picking: se puede completar con 0 ítems recogidos. Al crear la orden no se reserva stock (sobreventa).
- [ ] B8. `activity.log` se escribe con `this.prisma` en vez de `tx` (fuera de la transacción).
- [ ] B9. Secretos: `main.ts` compara contra un texto que no coincide con los de ejemplo, el JWT usa `'secret'` como valor por defecto, y `JWT_REFRESH_*` y `MAX_FILE_SIZE_MB` no se usan (30 días hardcodeado).
- [ ] B10. No se detecta la reutilización de refresh tokens, que además se guardan en texto plano.
- [ ] B11. `ThrottlerModule` está configurado pero no hay `ThrottlerGuard` global.
- [ ] B12. `/health` responde 200 aunque la BD esté caída.
- [ ] B13. `products.service.ts`: el filtro `stockStatus` se aplica después de paginar, así que el `total` sale mal.
- [ ] B14. `reports.service.ts` carga tablas enteras en memoria.
- [ ] B15. `UpdateUserDto.active` no tiene `@IsBoolean`, y un admin puede desactivarse a sí mismo o dejar el sistema sin admin.
- [ ] B16. Swagger documenta `traslado_entrada/salida`, pero el enum real es `entrada_traslado/salida_traslado`.
- [ ] B17. Uploads solo en disco local, sin procesar imágenes ni limpiar huérfanos.
- [ ] B18. `NotificationsService` (Expo push) nunca se invoca.
- [ ] B19. Falta un endpoint `/auth/me` (perfil y cambio de la contraseña propia).
- [ ] B20. Docker: corre como root, sin HEALTHCHECK, sin `prisma migrate deploy`, con secretos hardcodeados en `docker-compose.yml`.
- [ ] B21. Cero tests (no existe `test/jest-e2e.json`) y sin CI.

**Frontend web**

- [ ] F1. Llama a `/stock/products/:id/movements`, pero la ruta real es `/products/:id/movements` (404): están rotos el ajuste manual y el historial del producto.
- [ ] F2. Envía `limit` de 200, 500 y 10000, pero el backend permite como máximo 100 (400). Fallan los selectores de producto y la exportación CSV.
- [ ] F3. El dashboard llama a `reports/*` (solo supervisor), así que el operario recibe 403. `/perfil` usa `PATCH /users/:id` (solo admin).
- [ ] F4. No hay guard de rol por ruta: un operario puede entrar a `/usuarios`, `/bodegas` y `/reportes`.
- [ ] F5. Los tokens se duplican en localStorage (claves sueltas y blob de Zustand) y se desincronizan al hacer refresh.
- [ ] F6. Ninguna query maneja `isError`: un fallo se ve como una tabla vacía.
- [ ] F7. Sin tests, sin Dockerfile, sin CI, sin `.env.example`.

**App móvil**

- [ ] M1. No restaura la sesión al abrir: `AppNavigator.tsx:79` siempre empieza en Login.
- [ ] M2. Si el refresh falla, las peticiones en cola (`refreshSubscribers`) quedan colgadas para siempre.
- [ ] M3. `uploads.service.ts` no maneja 401/refresh.
- [ ] M4. `AppContext` sigue cargando `mockData`, y las notificaciones locales salen de esos datos simulados.
- [ ] M5. Aparece "¿Descartar cambios?" después de guardar con éxito (Create/Edit Picking, CreatePacking, ProductForm).
- [ ] M6. ProductForm no envía `location`.
- [ ] M7. Scanner: un escaneo hecho antes de que carguen los ítems se marca como "no pertenece", y las pantallas de detalle no se refrescan al volver.
- [ ] M8. Los toggles de sonido y vibración no hacen nada.
- [ ] M9. Las listas se truncan en 100 sin paginación.
- [ ] M10. La referencia de la orden se genera en el cliente y puede repetirse.
- [ ] M11. El push token nunca se registra. Se piden permisos innecesarios (RECORD_AUDIO, WRITE_EXTERNAL_STORAGE).
- [ ] M12. Sin tests ni lint. Todo por HTTP plano.

## 5. Fases

Las estimaciones son gruesas, para 1–2 desarrolladores. **Primera versión vendible = fases 0, 1, 2, 3, 4 y 6 + cobro básico (≈ 4–5 meses).**

### Fase 0 — Estabilización (1–2 semanas)
- [ ] 0.1 Backend: DTOs con class-validator en todos los endpoints (B1, B2, B15, B16).
- [ ] 0.2 Backend: guards de rol y de alcance por bodega (B3).
- [ ] 0.3 Backend: stock atómico, `CHECK >= 0`, validaciones de traslado, reservas correctas en picking y packing, log dentro de la transacción (B4–B8).
- [ ] 0.4 Backend: seguridad y plataforma: secretos, throttler, health 503, refresh tokens hasheados con detección de reutilización, `/auth/me` (B9–B12, B19).
- [ ] 0.5 Backend: paginación correcta en productos y reportes agregados en SQL (B13, B14).
- [ ] 0.6 Backend: suite de tests (unitarios + e2e del flujo reserva → picking → packing → descuento) y CI (B21).
- [ ] 0.7 Frontend: F1–F6.
- [ ] 0.8 Móvil: M1–M9 y M11; eliminar la capa de datos simulados.
- [ ] 0.9 Docker y CI en los tres repos (B20, F7, M12).

### Fase 1 — Base SaaS (3–4 semanas)
- [ ] 1.1 Modelo `Tenant` (slug, plan, estado, configuración, feature flags) y `tenantId` en todas las tablas, con migración de los datos actuales a un tenant "default".
- [ ] 1.2 Extensión de Prisma que inyecte `tenantId` y políticas RLS en PostgreSQL.
- [ ] 1.3 Login por tenant (subdominio o slug) con el tenant en el JWT.
- [ ] 1.4 Roles y permisos configurables por tenant (reemplazan el enum fijo) e invitación de usuarios por correo.
- [ ] 1.5 Consola de super-admin de la plataforma: crear, suspender y entrar como soporte a un tenant, y métricas de uso.
- [ ] 1.6 Auditoría general (interceptor), por tenant.
- [ ] 1.7 Almacenamiento S3-compatible con prefijo por tenant.
- [ ] 1.8 Límites por plan (usuarios, bodegas, operaciones al mes).

### Fase 2 — Datos maestros configurables (3 semanas)
- [ ] 2.1 Ubicaciones jerárquicas (bodega → zona → pasillo → estante → nivel → posición) con tipo y capacidad.
- [ ] 2.2 Stock por ubicación (`LocationStock`), con migración desde `WarehouseStock.location`.
- [ ] 2.3 Clientes y proveedores.
- [ ] 2.4 Unidades de medida con conversiones y varios códigos de barras por producto.
- [ ] 2.5 Lotes, series y vencimiento (activables por tenant y por producto). Cantidades decimales.
- [ ] 2.6 Campos personalizados por tenant.
- [ ] 2.7 Importación masiva Excel/CSV (productos, ubicaciones, stock inicial) e impresión de etiquetas.

### Fase 3 — Entradas (3 semanas)
- [ ] 3.1 Órdenes de compra.
- [ ] 3.2 Avisos de llegada (ASN).
- [ ] 3.3 Recepción (ciega o contra la orden) con escaneo y diferencias.
- [ ] 3.4 Putaway con reglas configurables.
- [ ] 3.5 Devoluciones (RMA).
- [ ] 3.6 Flujos móviles de recepción y putaway.

### Fase 4 — Salidas (4 semanas)
- [ ] 4.1 Pedido de venta → asignación y reserva → tareas de picking.
- [ ] 4.2 Picking por pedido, en lote o por olas, con ruta por ubicación.
- [ ] 4.3 Estrategias FIFO, FEFO y LIFO configurables.
- [ ] 4.4 Packing con contenido por caja y etiquetas ZPL/PDF.
- [ ] 4.5 Despacho, transportadora, guía y prueba de entrega.
- [ ] 4.6 Referencias generadas en el backend con secuencias por tenant (M10).

### Fase 5 — Control de inventario (2–3 semanas)
- [ ] 5.1 Conteos cíclicos con aprobación de diferencias.
- [ ] 5.2 Traslados con estado en tránsito y recepción en el destino.
- [ ] 5.3 Reabastecimiento por mínimo y máximo.
- [ ] 5.4 Notificaciones push y por correo reales (B18).

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

## 6. Estado actual

- **Fase en curso:** Fase 0.
- **Siguiente tarea:** 0.1 / 0.2 / 0.3 en el módulo `stock` del backend.
- **Notas:** el endpoint `PATCH /stock/products/:productId/warehouse/:warehouseId` (location y minStock) se agregó antes de este plan y se ajusta dentro de la tarea 0.1/0.2.
