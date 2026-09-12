import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';

const PRODUCT_EXAMPLE = {
  id: 'p001',
  code: 'FLT-0001',
  name: 'Filtro de Aceite CAT 1R-0716',
  description: 'Filtro de aceite de motor de alta eficiencia',
  category: 'Filtros',
  barcode: '7891234560001',
  unit: 'UND',
  brand: 'Caterpillar',
  compatibility: ['CAT 320D', 'CAT 330'],
  imageUrl: null,
  photos: [],
  active: true,
  createdAt: '2025-01-10T08:00:00.000Z',
  updatedAt: '2025-06-01T14:22:00.000Z',
  warehouseStock: {
    warehouseId: '4f749c36-91a8-4e0f-928f-d8915c2ba8ec',
    location: 'A-01-03',
    minStock: 10,
    stockFisico: 45,
    stockReservado: 10,
    stockDisponible: 35,
  },
};

const ERR_401 = { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado', requestId: 'req_abc123' };
const ERR_403 = { error: 'AUTH_UNAUTHORIZED', message: 'Acceso denegado', requestId: 'req_abc123' };
const ERR_404_PRODUCT = { error: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado', requestId: 'req_abc123' };
const ERR_409_BARCODE = { error: 'BARCODE_DUPLICATE', message: 'Ya existe un producto con ese código de barras', requestId: 'req_abc123' };
const ERR_422 = { error: 'VALIDATION_ERROR', message: 'Datos de entrada inválidos', details: [{ field: 'code', message: 'must not be empty' }], requestId: 'req_abc123' };

@ApiTags('products')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'Listar productos',
    description: `Devuelve el catálogo paginado con el stock calculado para el almacén del usuario autenticado.
El campo \`warehouseStock\` puede ser \`null\` si el producto no tiene stock en ese almacén.

**Ejemplo de llamada:**
\`\`\`http
GET /v1/products?search=filtro&category=Filtros&page=1&limit=20
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiQuery({ name: 'search', required: false, description: 'Busca en código, nombre, barcode, marca, categoría', example: 'filtro' })
  @ApiQuery({ name: 'category', required: false, description: 'Filtrar por categoría exacta', example: 'Filtros' })
  @ApiQuery({ name: 'stockStatus', required: false, enum: ['ok', 'low', 'out'], description: '`ok` = sobre mínimo | `low` = en/bajo mínimo | `out` = sin stock' })
  @ApiQuery({ name: 'warehouseId', required: false, description: 'Almacén para calcular stock (por defecto: almacén del usuario)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de productos',
    schema: {
      example: {
        data: [PRODUCT_EXAMPLE],
        meta: { total: 150, page: 1, limit: 20, totalPages: 8 },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  findAll(@Query() q: ProductQueryDto, @CurrentUser() user: AuthUser) {
    return this.productsService.findAll(q, user.warehouseId!);
  }

  @Get('barcode/:barcode')
  @ApiOperation({
    summary: 'Buscar por código de barras',
    description: `Lookup rápido para el lector de barras del scanner. Devuelve el producto con stock del almacén del usuario.

**Ejemplo de llamada:**
\`\`\`http
GET /v1/products/barcode/7891234560001
Authorization: Bearer eyJ...
\`\`\``,
  })
  @ApiParam({ name: 'barcode', example: '7891234560001', description: 'Código EAN/UPC del producto' })
  @ApiResponse({ status: 200, description: 'Producto encontrado', schema: { example: PRODUCT_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  findByBarcode(@Param('barcode') barcode: string, @CurrentUser() user: AuthUser) {
    return this.productsService.findByBarcode(barcode, user.warehouseId!);
  }

  @Get(':id/stock')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Stock por almacén',
    description: 'Devuelve el inventario de un producto desglosado por cada almacén donde existe.',
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiResponse({
    status: 200,
    description: 'Stock por almacén',
    schema: {
      example: [
        {
          warehouse: { id: 'wh_001', code: 'BOG-01', name: 'Bodega Bogotá', active: true },
          stockFisico: 100,
          stockReservado: 20,
          stockDisponible: 80,
          minStock: 10,
          location: 'A-01-01',
        },
        {
          warehouse: { id: 'wh_002', code: 'MED-01', name: 'Bodega Medellín', active: true },
          stockFisico: 30,
          stockReservado: 0,
          stockDisponible: 30,
          minStock: 5,
          location: 'B-02-04',
        },
      ],
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  async getStock(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const product = await this.productsService.findById(id, user.warehouseId!);
    return product.allWarehousesStock;
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detalle de producto',
    description: 'Devuelve el producto completo con stock del almacén del usuario y `allWarehousesStock` con el inventario de todos los almacenes.',
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiResponse({
    status: 200,
    description: 'Producto encontrado',
    schema: {
      example: {
        ...PRODUCT_EXAMPLE,
        allWarehousesStock: [
          { warehouse: { id: 'wh_001', code: 'BOG-01', name: 'Bodega Bogotá', active: true }, stockFisico: 45, stockReservado: 10, stockDisponible: 35, minStock: 10, location: 'A-01-03' },
          { warehouse: { id: 'wh_002', code: 'MED-01', name: 'Bodega Medellín', active: true }, stockFisico: 20, stockReservado: 0, stockDisponible: 20, minStock: 5, location: 'C-03-01' },
        ],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  findOne(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.productsService.findById(id, user.warehouseId!);
  }

  @Post()
  @Roles(Role.supervisor)
  @ApiOperation({
    summary: 'Crear producto',
    description: `Agrega un producto al catálogo global. **Requiere rol supervisor o admin.**

El stock se gestiona por almacén a través de movimientos de stock, no aquí.

**Ejemplo de llamada:**
\`\`\`http
POST /v1/products
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "code": "FLT-0002",
  "name": "Filtro Hidráulico CAT 1R-0741",
  "category": "Filtros",
  "barcode": "7891234560002",
  "unit": "UND",
  "brand": "Caterpillar"
}
\`\`\``,
  })
  @ApiResponse({ status: 201, description: 'Producto creado', schema: { example: PRODUCT_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 409, description: 'Código de barras duplicado', schema: { example: ERR_409_BARCODE } })
  @ApiResponse({ status: 422, description: 'Datos inválidos', schema: { example: ERR_422 } })
  create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @Roles(Role.supervisor)
  @ApiOperation({
    summary: 'Editar producto',
    description: 'Actualiza los datos del catálogo (nombre, categoría, etc). **No modifica stock** — para eso usar `POST /v1/products/:id/movements`. **Requiere rol supervisor o admin.**',
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiResponse({ status: 200, description: 'Producto actualizado', schema: { example: PRODUCT_EXAMPLE } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  @ApiResponse({ status: 409, description: 'Código de barras duplicado', schema: { example: ERR_409_BARCODE } })
  update(@Param('id') id: string, @Body() dto: Partial<CreateProductDto>) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(Role.admin)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Desactivar producto (soft delete)',
    description: 'Marca el producto como inactivo (`active: false`). No lo elimina físicamente. **Requiere rol admin.**',
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiResponse({ status: 204, description: 'Producto desactivado' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  remove(@Param('id') id: string) {
    return this.productsService.softDelete(id);
  }

  @Post(':id/photos')
  @Roles(Role.supervisor)
  @ApiOperation({
    summary: 'Agregar foto al producto',
    description: `Asocia una URL de foto al producto. **Flujo recomendado:**
1. Subir el archivo con \`POST /v1/uploads/photo\`
2. Usar la \`url\` devuelta aquí

**Requiere rol supervisor o admin.**`,
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiResponse({
    status: 201,
    description: 'Foto agregada',
    schema: { example: { ...PRODUCT_EXAMPLE, photos: ['https://api.wmspro.com/uploads/photo_abc123.jpg'] } },
  })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  addPhoto(@Param('id') id: string, @Body('url') url: string) {
    return this.productsService.addPhoto(id, url);
  }

  @Delete(':id/photos/:photoUrl')
  @Roles(Role.supervisor)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Eliminar foto del producto',
    description: 'Quita la URL de la lista de fotos. El parámetro `photoUrl` debe estar **URL-encoded** al incluirlo en el path.',
  })
  @ApiParam({ name: 'id', description: 'ID del producto', example: 'p001' })
  @ApiParam({ name: 'photoUrl', description: 'URL de la foto (URL-encoded)', example: 'https%3A%2F%2Fapi.wmspro.com%2Fuploads%2Fphoto_abc123.jpg' })
  @ApiResponse({ status: 204, description: 'Foto eliminada' })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: ERR_401 } })
  @ApiResponse({ status: 403, description: 'Rol insuficiente', schema: { example: ERR_403 } })
  @ApiResponse({ status: 404, description: 'Producto no encontrado', schema: { example: ERR_404_PRODUCT } })
  removePhoto(@Param('id') id: string, @Param('photoUrl') photoUrl: string) {
    return this.productsService.removePhoto(id, decodeURIComponent(photoUrl));
  }
}
