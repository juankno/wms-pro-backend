import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseEnumPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { ImportJobsService, REQUIRED_PERMISSION } from './import-jobs.service';
import { IMPORT_KINDS, IMPORT_TEMPLATES, ImportKind, ImportsService, MAX_ASYNC_IMPORT_ROWS } from './imports.service';
import { detectFormat, FORMAT_CONTENT_TYPES, IMPORT_FORMATS, ImportFormat, xlsxTemplate } from './spreadsheet';
import { MAX_IMPORT_ROWS } from './csv';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ASYNC_FILE_BYTES = 25 * 1024 * 1024;

const kindPipe = new ParseEnumPipe(IMPORT_KINDS);
const formatPipe = new ParseEnumPipe(IMPORT_FORMATS, { optional: true });

type UploadedSpreadsheet = { buffer: Buffer; originalname?: string };

const FILE_BODY = { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } };

function assertCanImport(kind: ImportKind, user: AuthUser) {
  const permission = REQUIRED_PERMISSION[kind];
  if (!user.permissions.includes(permission)) {
    throw new ForbiddenException({
      error: 'PERMISSION_DENIED',
      message: 'No tienes permiso para esta importación',
      details: { missing: [permission] },
    });
  }
}

function requireFile(file: UploadedSpreadsheet | undefined): UploadedSpreadsheet {
  if (!file) throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'No se recibió ningún archivo' });
  return file;
}

@ApiTags('imports')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('imports')
export class ImportsController {
  constructor(
    private imports: ImportsService,
    private importJobs: ImportJobsService,
  ) {}

  @Get(':kind/template')
  @ApiOperation({ summary: 'Plantilla con las columnas y filas de ejemplo (CSV por defecto, o XLSX)' })
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  @ApiQuery({ name: 'format', enum: IMPORT_FORMATS, required: false })
  async template(@Param('kind', kindPipe) kind: ImportKind, @Query('format', formatPipe) format: ImportFormat | undefined) {
    const chosen = format ?? 'csv';
    const content = chosen === 'xlsx' ? await xlsxTemplate(IMPORT_TEMPLATES[kind]) : Buffer.from(IMPORT_TEMPLATES[kind]);
    return new StreamableFile(content, {
      type: FORMAT_CONTENT_TYPES[chosen],
      disposition: `attachment; filename="plantilla-${kind}.${chosen}"`,
    });
  }

  @Post(':kind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validar o importar al instante un archivo pequeño (CSV o XLSX)',
    description:
      `Hasta ${MAX_IMPORT_ROWS} filas. CSV con separador \`,\` o \`;\`; XLSX lee la primera hoja. ` +
      'Con `dryRun=true` solo valida y devuelve los errores por línea. ' +
      'Sin errores, aplica todo en una transacción; con errores no importa nada (422 IMPORT_INVALID). ' +
      'Productos y ubicaciones se crean o actualizan por código; el stock se suma como saldo inicial.',
  })
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  run(
    @Param('kind', kindPipe) kind: ImportKind,
    @Query('dryRun', new ParseBoolPipe({ optional: true })) dryRun: boolean | undefined,
    @UploadedFile() file: UploadedSpreadsheet | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    assertCanImport(kind, user);
    const { buffer, originalname } = requireFile(file);
    return this.imports.run(kind, buffer, detectFormat(buffer, originalname), dryRun ?? false, user);
  }

  @Post(':kind/jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Importar en segundo plano un archivo grande (CSV o XLSX)',
    description:
      `Hasta ${MAX_ASYNC_IMPORT_ROWS} filas. Devuelve el trabajo; su progreso y resultado se consultan en \`GET /jobs/:id\`. ` +
      'Si hay errores no se importa nada y el trabajo queda fallido con un reporte descargable en `GET /imports/jobs/:id/errors`.',
  })
  @ApiParam({ name: 'kind', enum: IMPORT_KINDS })
  @ApiConsumes('multipart/form-data')
  @ApiBody(FILE_BODY)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ASYNC_FILE_BYTES } }))
  enqueue(
    @Param('kind', kindPipe) kind: ImportKind,
    @UploadedFile() file: UploadedSpreadsheet | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    assertCanImport(kind, user);
    const upload = requireFile(file);
    return this.importJobs.enqueue(kind, upload, detectFormat(upload.buffer, upload.originalname), user);
  }

  @Get('jobs/:id/errors')
  @ApiOperation({ summary: 'Reporte CSV con las filas rechazadas de una importación en segundo plano' })
  async errorReport(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const { content, fileName } = await this.importJobs.errorReport(id, user);
    return new StreamableFile(content, {
      type: FORMAT_CONTENT_TYPES.csv,
      // RFC 5987 keeps accents and spaces of the uploaded file name.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
  }
}
