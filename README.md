# WMS Pro — Backend API

API REST para WMS Pro, sistema de gestión de almacenes (Warehouse Management System). Construida con NestJS, Prisma y PostgreSQL.

## Stack

| Tecnología | Versión | Rol |
|-----------|---------|-----|
| **NestJS** | 10.x | Framework HTTP |
| **TypeScript** | 5.x | Lenguaje |
| **Prisma** | 5.x | ORM + migraciones |
| **PostgreSQL** | 16+ | Base de datos |
| **JWT** | — | Autenticación |
| **Scalar** | — | Documentación interactiva |
| **class-validator** | — | Validación de DTOs |

---

## Requisitos previos

- Node.js 20+
- PostgreSQL 16+ corriendo localmente
- npm 10+

---

## Setup inicial

### 1. Instalar dependencias

```bash
cd backend
npm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` con tus credenciales:

```env
DATABASE_URL="postgresql://postgres:TU_PASSWORD@localhost:5432/wms_pro"
JWT_SECRET="cambia-esto-en-produccion"
JWT_REFRESH_SECRET="cambia-esto-tambien-en-produccion"
```

### 3. Crear la base de datos y aplicar migraciones

```bash
npm run prisma:migrate
```

### 4. Poblar con datos de prueba

```bash
npm run prisma:seed
```

Crea 2 almacenes, 3 usuarios y 20 productos con stock variado.

### 5. Arrancar el servidor

```bash
npm run start:dev     # modo watch (desarrollo)
npm run start:prod    # producción (requiere build previo)
npm run build         # compilar TypeScript
```

El servidor corre en `http://localhost:3000` por defecto.

---

## Documentación

| URL | Descripción |
|-----|-------------|
| `http://localhost:3000/docs` | **Scalar** — UI interactiva moderna |
| `http://localhost:3000/v1/docs-json-ui-json` | OpenAPI JSON (spec raw) |

---

## Scripts disponibles

```bash
npm run start:dev          # Servidor en modo watch
npm run build              # Compilar a dist/
npm run start:prod         # Servidor de producción
npm run lint               # Linter
npm run test               # Tests unitarios
npm run test:e2e           # Tests end-to-end

npm run prisma:generate    # Regenerar Prisma Client
npm run prisma:migrate     # Aplicar migraciones
npm run prisma:seed        # Poblar base de datos
npm run prisma:studio      # Prisma Studio (explorador visual de la BD)
```

---

## Variables de entorno

| Variable | Descripción | Default |
|----------|-------------|---------|
| `DATABASE_URL` | Connection string PostgreSQL | — (requerido) |
| `JWT_SECRET` | Secreto para firmar access tokens | — (requerido) |
| `JWT_EXPIRES_IN` | TTL del access token | `1h` |
| `JWT_REFRESH_SECRET` | Secreto para refresh tokens | — (requerido) |
| `JWT_REFRESH_EXPIRES_IN` | TTL del refresh token | `30d` |
| `PORT` | Puerto del servidor | `3000` |
| `API_PREFIX` | Prefijo global de la API | `v1` |
| `UPLOAD_DIR` | Directorio de uploads | `./uploads` |
| `MAX_FILE_SIZE_MB` | Tamaño máximo de archivos | `10` |
| `CORS_ORIGINS` | Orígenes CORS permitidos (coma separados) | `*` |
| `NODE_ENV` | Entorno de ejecución | `development` |

---

## Arquitectura

```
backend/
├── prisma/
│   ├── schema.prisma        # Modelos de datos
│   ├── seed.ts              # Datos iniciales
│   └── migrations/          # Historial de migraciones
│
└── src/
    ├── main.ts              # Bootstrap + Scalar + CORS + pipes
    ├── app.module.ts        # Módulo raíz
    │
    ├── common/              # Utilidades transversales
    │   ├── decorators/      # @CurrentUser, @Roles
    │   ├── dto/             # PaginationDto, buildMeta
    │   ├── filters/         # HttpExceptionFilter (errores uniformes)
    │   ├── guards/          # RolesGuard
    │   ├── interceptors/    # TransformInterceptor
    │   └── types/           # JwtPayload, AuthUser, RequestWithUser
    │
    ├── prisma/              # PrismaService global
    ├── auth/                # JWT, login, refresh, logout
    ├── users/               # Gestión de usuarios
    ├── warehouses/          # Gestión de almacenes
    ├── products/            # Catálogo + stock por almacén
    ├── stock/               # Movimientos + traslados atómicos
    ├── picking/             # Órdenes de picking + reserva progresiva
    ├── packing/             # Órdenes de packing + descuento de stock
    ├── activity/            # Log de auditoría inmutable
    ├── reports/             # Dashboard KPIs
    ├── uploads/             # Subida de fotos
    └── notifications/       # Expo Push API
```

---

## Módulos y endpoints

### Auth `/v1/auth`
| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| POST | `/login` | Login con usuario y contraseña | — |
| POST | `/refresh` | Renovar access token | — |
| POST | `/logout` | Invalidar sesión | JWT |
| PATCH | `/me/push-token` | Registrar token de notificaciones | JWT |

### Almacenes `/v1/warehouses`
| Método | Ruta | Rol mínimo |
|--------|------|-----------|
| GET | `/` | operator |
| GET | `/:id` | operator |
| POST | `/` | admin |
| PATCH | `/:id` | admin |

### Productos `/v1/products`
| Método | Ruta | Rol mínimo |
|--------|------|-----------|
| GET | `/` | operator |
| GET | `/:id` | operator |
| GET | `/barcode/:barcode` | operator |
| POST | `/` | supervisor |
| PATCH | `/:id` | supervisor |
| DELETE | `/:id` | admin |
| POST | `/:id/photos` | supervisor |
| DELETE | `/:id/photos/:url` | supervisor |

### Stock `/v1/stock`
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/movements` | Historial global paginado |
| POST | `/transfer` | Traslado atómico entre almacenes |
| POST | `/products/:id/movements` | Registrar movimiento manual |
| GET | `/products/:id/movements` | Historial de un producto |

### Picking `/v1/picking`
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Listar órdenes (filtros: status, search, assignedTo, from, to) |
| GET | `/:id` | Detalle con ítems |
| POST | `/` | Crear (valida stock disponible) |
| PATCH | `/:id/status` | Cambiar estado (reserva/libera stock) |
| PATCH | `/:id/items/:itemId` | Actualizar cantidad recogida |
| DELETE | `/:id` | Eliminar (solo `pending`, supervisor+) |

### Packing `/v1/packing`
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Listar órdenes |
| GET | `/:id` | Detalle con cajas |
| POST | `/` | Crear desde picking completado |
| PATCH | `/:id/status` | Cambiar estado (completa → descuenta stock) |
| POST | `/:id/boxes` | Agregar caja |
| PATCH | `/:id/boxes/:boxId/seal` | Sellar caja |
| DELETE | `/:id` | Eliminar (solo `pending`, supervisor+) |

### Actividad `/v1/activity`
| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/` | Log global paginado |
| GET | `/order/:orderId` | Log de una orden |

### Reportes `/v1/reports`
| Método | Ruta | Rol mínimo |
|--------|------|-----------|
| GET | `/dashboard` | KPIs del almacén | supervisor |

### Uploads `/v1/uploads`
| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/photo` | Subir imagen (multipart/form-data, max 10MB) |

---

## Autenticación

```http
POST /v1/auth/login
Content-Type: application/json

{ "username": "operario", "password": "op123" }
```

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "uuid-v4...",
  "expiresIn": 3600,
  "user": {
    "id": "...",
    "name": "Juan Operario",
    "role": "operator",
    "warehouseId": "...",
    "warehouseName": "Bodega Principal Bogotá"
  }
}
```

Usar el `accessToken` en cada request:
```http
Authorization: Bearer eyJ...
```

---

## Reglas de negocio críticas

### Flujo de stock
```
CREAR PICKING  → valida stockDisponible >= quantity (409 si falla)
RECOGER ÍTEM   → delta = nuevaQty - anteriorQty → stockReservado += delta
DESMARCAR ÍTEM → stockReservado -= delta (libera reserva)
CANCELAR PICKING → stockReservado -= pickedQuantity + genera entrada_devolucion
COMPLETAR PACKING → stockFisico -= packedQty, stockReservado -= packedQty
                    + genera salida_picking (transacción atómica)
```

### Invariantes de stock
- `stockDisponible = stockFisico - stockReservado` — siempre
- `stockFisico >= 0`, `stockReservado >= 0`, `stockDisponible >= 0` — nunca negativos
- Cada cambio genera un `StockMovement` **inmutable**

### Transiciones de estado válidas
```
PickingOrder:  pending → in_progress → completed
               pending → cancelled
               in_progress → cancelled  (libera reservas)

PackingOrder:  pending → in_progress → completed  (descuenta stock)
               pending → cancelled
               in_progress → cancelled
```

---

## Datos de prueba (seed)

| Usuario | Contraseña | Rol |
|---------|-----------|-----|
| `admin` | `admin123` | admin |
| `supervisor` | `sup123` | supervisor |
| `operario` | `op123` | operator |

**Almacenes:** Bogotá (`BOG-01`) y Medellín (`MED-01`)  
**Productos:** 20 en catálogo (stock variado: sin stock, bajo, normal)  
**Órdenes:** 5 pickings + 2 packings en distintos estados

---

## Índices de base de datos

Los índices críticos para el rendimiento están definidos en el schema de Prisma:

```sql
-- Búsquedas frecuentes de la app
CREATE INDEX ON stock_movements(product_id, warehouse_id, created_at DESC);
CREATE INDEX ON picking_orders(warehouse_id, status);
CREATE INDEX ON warehouse_stock(product_id, warehouse_id);
CREATE UNIQUE INDEX ON products(barcode);
```

---

## Concurrencia y transacciones

Las operaciones de stock usan `prisma.$transaction()` con bloqueos a nivel de fila para prevenir condiciones de carrera cuando múltiples operarios trabajan simultáneamente. Un conflicto retorna `409 STOCK_INSUFICIENTE`.
