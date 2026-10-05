import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseEnumPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Permission } from '../auth/permissions';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { IMPORT_KINDS, IMPORT_TEMPLATES, ImportKind, ImportsService } from './imports.service';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const REQUIRED_PERMISSION: Record<ImportKind, Permission> = {
  products: 'products.write',
  locations: 'locations.manage',
  stock: 'stock.adjust',
};

const kindPipe = new ParseEnumPipe(IMPORT_KINDS);

@ApiTags('imports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('imports')
export class ImportsController {
  constructor(private imports: ImportsService) {}

  @Get(':kind/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({ summary: 'Plantilla CSV con las columnas y una fila de ejemplo' })
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  template(@Param('kind', kindPipe) kind: ImportKind) {
    return IMPORT_TEMPLATES[kind];
  }

  @Post(':kind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Importar productos, ubicaciones o stock inicial desde CSV',
    description:
      'Separador `,` o `;`. Con `dryRun=true` solo valida y devuelve los errores por línea. ' +
      'Sin errores, aplica todo en una transacción; con errores no importa nada (422 IMPORT_INVALID). ' +
      'Productos y ubicaciones se crean o actualizan por código; el stock se suma como saldo inicial.',
  })
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  run(
    @Param('kind', kindPipe) kind: ImportKind,
    @Query('dryRun', new ParseBoolPipe({ optional: true })) dryRun: boolean | undefined,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const permission = REQUIRED_PERMISSION[kind];
    if (!user.permissions.includes(permission)) {
      throw new ForbiddenException({
        error: 'PERMISSION_DENIED',
        message: 'No tienes permiso para esta importación',
        details: { missing: [permission] },
      });
    }
    if (!file) throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'No se recibió ningún archivo' });
    return this.imports.run(kind, file.buffer, dryRun ?? false, user);
  }
}
