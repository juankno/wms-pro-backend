import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

function validateEnv() {
  const required = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Variables de entorno requeridas no definidas: ${missing.join(', ')}`);
  }
  const insecure = ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter(
    (k) =>
      process.env[k]?.includes('change-in-production') ||
      process.env[k]?.includes('your-super-secret'),
  );
  if (insecure.length && process.env.NODE_ENV === 'production') {
    throw new Error(`Secretos inseguros detectados en producción: ${insecure.join(', ')}`);
  }
}

async function bootstrap() {
  validateEnv();

  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.enableShutdownHooks();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
          fontSrc: ["'self'", 'fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );

  const allowedOrigins = process.env.CORS_ORIGINS?.split(',').map((o) => o.trim());
  app.enableCors({
    origin: allowedOrigins?.length ? allowedOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  const prefix = process.env.API_PREFIX ?? 'v1';
  app.setGlobalPrefix(prefix, { exclude: ['health', 'docs', 'docs-json-ui-json'] });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  const config = new DocumentBuilder()
    .setTitle('WMS Pro API')
    .setDescription(
      `REST API para WMS Pro — sistema de gestión de almacenes.

## Autenticación
Todos los endpoints (excepto \`POST /auth/login\` y \`POST /auth/refresh\`) requieren un **Bearer token** en el header \`Authorization\`.

## Flujo de tokens
1. \`POST /auth/login\` → recibe \`accessToken\` (1h) y \`refreshToken\` (30d)
2. Cuando el \`accessToken\` expira → \`POST /auth/refresh\` con el \`refreshToken\`
3. Si el \`refreshToken\` expira → redirigir al login

## Roles
| Rol | Permisos |
|-----|----------|
| \`operator\` | Picking, packing, movimientos de stock, lectura de productos |
| \`supervisor\` | Todo lo anterior + gestión de productos + reportes + eliminar órdenes |
| \`admin\` | Todo + gestión de usuarios y almacenes |

## Reglas de stock
- \`stockDisponible = stockFisico - stockReservado\` — nunca negativo
- El stock se **reserva** al recoger ítems en picking
- El stock se **descuenta** al completar el packing (transacción atómica)
- Cada cambio genera un **StockMovement** inmutable

## Paginación
Todas las listas devuelven:
\`\`\`json
{ "data": [...], "meta": { "total": 150, "page": 1, "limit": 20, "totalPages": 8 } }
\`\`\`

## Códigos de error
| Código | HTTP | Descripción |
|--------|------|-------------|
| \`AUTH_INVALID_CREDENTIALS\` | 401 | Usuario o contraseña incorrectos |
| \`AUTH_TOKEN_EXPIRED\` | 401 | Access token expirado |
| \`AUTH_REFRESH_EXPIRED\` | 401 | Refresh token expirado — hacer login |
| \`AUTH_UNAUTHORIZED\` | 403 | Rol insuficiente |
| \`STOCK_INSUFICIENTE\` | 409 | Stock disponible insuficiente |
| \`ORDER_NOT_FOUND\` | 404 | Orden no encontrada |
| \`PRODUCT_NOT_FOUND\` | 404 | Producto no encontrado |
| \`WAREHOUSE_NOT_FOUND\` | 404 | Almacén no encontrado |
| \`ORDER_INVALID_STATUS\` | 422 | Transición de estado no válida |
| \`PICKING_INCOMPLETE\` | 422 | El picking no está completado |
| \`VALIDATION_ERROR\` | 422 | Datos de entrada inválidos |
| \`BARCODE_DUPLICATE\` | 409 | Código de barras ya existe |
| \`RATE_LIMIT_EXCEEDED\` | 429 | Demasiadas solicitudes |`,
    )
    .setVersion('2.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addTag('health', 'Estado del servicio')
    .addTag('auth', 'Autenticación y gestión de sesión')
    .addTag('warehouses', 'Gestión de almacenes')
    .addTag('users', 'Gestión de usuarios')
    .addTag('products', 'Catálogo de productos e inventario')
    .addTag('stock', 'Movimientos de stock y traslados')
    .addTag('picking', 'Órdenes de picking')
    .addTag('packing', 'Órdenes de packing')
    .addTag('activity', 'Registro de actividad y auditoría')
    .addTag('reports', 'Reportes y estadísticas')
    .addTag('uploads', 'Carga de archivos')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs-json-ui', app, document, { useGlobalPrefix: false });

  app.use(
    '/docs',
    apiReference({
      spec: { url: '/docs-json-ui-json' },
      theme: 'purple',
      layout: 'modern',
      defaultHttpClient: { targetKey: 'js', clientKey: 'fetch' },
      authentication: { preferredSecurityScheme: 'access-token' },
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`WMS Pro API → http://localhost:${port}/${prefix}`);
  logger.log(`Scalar docs  → http://localhost:${port}/docs`);
  logger.log(`Health check → http://localhost:${port}/health`);
}

bootstrap();
