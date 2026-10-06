import { Body, Controller, Get, Param, ParseEnumPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { formatReference, SEQUENCE_DEFAULTS, SequenceKey } from './sequence';

class UpdateSequenceDto {
  @ApiPropertyOptional({ example: 'PED' })
  @IsOptional()
  @Matches(/^[A-Z0-9]{1,10}$/, { message: 'El prefijo usa mayúsculas y números, hasta 10' })
  prefix?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 10 }) @IsOptional() @IsInt() @Min(1) @Max(10) padding?: number;
  @ApiPropertyOptional({ minimum: 1, description: 'Next number to use' }) @IsOptional() @IsInt() @Min(1) nextValue?: number;
}

const keyPipe = new ParseEnumPipe(Object.keys(SEQUENCE_DEFAULTS));

@ApiTags('sequences')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('settings.manage')
@Controller('sequences')
export class SequencesController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'Numeración de documentos con el próximo código de cada uno' })
  async findAll() {
    const rows = await this.prisma.sequence.findMany();
    return (Object.keys(SEQUENCE_DEFAULTS) as SequenceKey[]).map((key) => {
      const row = rows.find((sequence) => sequence.key === key);
      const settings = row ?? { prefix: SEQUENCE_DEFAULTS[key], padding: 5, nextValue: 1 };
      return { key, ...settings, preview: formatReference(settings.prefix, settings.nextValue, settings.padding) };
    });
  }

  @Patch(':key')
  @ApiOperation({ summary: 'Cambiar prefijo, relleno o próximo número' })
  async update(@Param('key', keyPipe) key: SequenceKey, @Body() dto: UpdateSequenceDto) {
    const sequence = await this.prisma.sequence.upsert({
      where: { tenantId_key: { tenantId: requireTenantId(), key } },
      create: { tenantId: requireTenantId(), key, prefix: dto.prefix ?? SEQUENCE_DEFAULTS[key], padding: dto.padding, nextValue: dto.nextValue },
      update: dto,
    });
    return { ...sequence, preview: formatReference(sequence.prefix, sequence.nextValue, sequence.padding) };
  }
}
