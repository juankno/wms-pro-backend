import { Controller, Get, Param, Query, Res, StreamableFile, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/request-with-user.interface';
import { LabelContent, toZpl } from './label-content';
import { toPdf } from './label-pdf';
import { LabelsService, MAX_LABELS } from './labels.service';

const FORMATS = ['pdf', 'zpl'] as const;
type LabelFormat = (typeof FORMATS)[number];

const splitIds = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);

class LabelFormatDto {
  @ApiPropertyOptional({ enum: FORMATS, default: 'pdf' }) @IsOptional() @IsIn(FORMATS) format?: LabelFormat;
}

class ProductLabelsDto extends LabelFormatDto {
  @ApiPropertyOptional({ description: 'Comma-separated product ids' })
  @Transform(splitIds)
  @IsArray()
  @ArrayMaxSize(MAX_LABELS)
  @IsString({ each: true })
  ids!: string[];
}

class LocationLabelsDto extends LabelFormatDto {
  @ApiPropertyOptional({ description: 'Comma-separated location ids' })
  @IsOptional()
  @Transform(splitIds)
  @IsArray()
  @ArrayMaxSize(MAX_LABELS)
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'All active locations of the warehouse (or under parentId)' })
  @IsOptional()
  @IsString()
  warehouseId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() parentId?: string;
}

@ApiTags('labels')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('labels')
export class LabelsController {
  constructor(private labels: LabelsService) {}

  @Get('products')
  @ApiOperation({ summary: 'Etiquetas de productos en PDF (100 x 50 mm) o ZPL (Zebra 4 x 2")' })
  async products(@Query() query: ProductLabelsDto, @Res({ passthrough: true }) res: Response) {
    return this.render(await this.labels.products(query.ids), query.format ?? 'pdf', 'etiquetas-productos', res);
  }

  @Get('locations')
  @ApiOperation({ summary: 'Etiquetas de ubicaciones en PDF o ZPL, por ids o por almacén' })
  async locations(@Query() query: LocationLabelsDto, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return this.render(await this.labels.locations(query, user), query.format ?? 'pdf', 'etiquetas-ubicaciones', res);
  }

  @Get('packing/:id')
  @ApiOperation({ summary: 'Etiquetas de envío, una por caja, con la guía como código de barras' })
  async packing(@Param('id') id: string, @Query() query: LabelFormatDto, @CurrentUser() user: AuthUser, @Res({ passthrough: true }) res: Response) {
    return this.render(await this.labels.packing(id, user), query.format ?? 'pdf', 'etiquetas-envio', res);
  }

  private async render(labels: LabelContent[], format: LabelFormat, name: string, res: Response) {
    const pdf = format === 'pdf';
    res.set({
      'Content-Type': pdf ? 'application/pdf' : 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.${format}"`,
    });
    return new StreamableFile(pdf ? await toPdf(labels) : Buffer.from(toZpl(labels)));
  }
}
