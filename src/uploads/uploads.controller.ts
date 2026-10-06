import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UploadsService } from './uploads.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

interface MulterFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@ApiTags('uploads')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('uploads')
export class UploadsController {
  constructor(private uploadsService: UploadsService) {}

  @Post('photo')
  @ApiOperation({
    summary: 'Subir foto',
    description: `Sube una imagen y devuelve su URL para usar en productos, pickings o packings. Con almacenamiento local la URL es relativa al host de la API (\`/v1/uploads/...\`); con S3 es absoluta.

**Flujo recomendado:**
1. \`POST /uploads/photo\` → obtén la URL
2. Usa esa URL en \`POST /products/:id/photos\`, \`POST /picking/:id/photos\`, etc.

**Restricciones:** JPEG, PNG o WebP — máximo 10 MB.`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Imagen (JPEG, PNG, WebP — máx 10 MB)' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Imagen subida correctamente',
    schema: {
      example: {
        id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        url: '/v1/uploads/tenants/00000000-0000-4000-8000-000000000001/photos/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4.webp',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Formato no permitido o archivo muy grande', schema: { example: { error: 'VALIDATION_ERROR', message: 'Formato de imagen no permitido' } } })
  @ApiResponse({ status: 401, description: 'No autenticado', schema: { example: { error: 'AUTH_TOKEN_EXPIRED', message: 'Token inválido o expirado' } } })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  async uploadPhoto(@UploadedFile() file: MulterFile) {
    if (!file) throw new BadRequestException({ error: 'VALIDATION_ERROR', message: 'No se recibió ningún archivo' });
    return this.uploadsService.saveFile(file.buffer);
  }
}
