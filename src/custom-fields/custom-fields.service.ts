import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CustomFieldEntity, CustomFieldType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { applyCustomValues, CustomValues } from './custom-field-values';

type Client = Pick<PrismaService, 'customFieldDefinition'> | Prisma.TransactionClient;

// Validates and merges custom values for an entity; throws 422 CUSTOM_FIELDS_INVALID with the field errors.
export async function resolveCustomFields(
  client: Client,
  entity: CustomFieldEntity,
  current: Prisma.JsonValue | undefined,
  input: Record<string, unknown> | undefined,
  mode: 'create' | 'update',
): Promise<CustomValues | undefined> {
  if (mode === 'update' && input === undefined) return undefined;
  const definitions = await client.customFieldDefinition.findMany({ where: { entity, active: true } });
  const { values, errors } = applyCustomValues(definitions, (current ?? {}) as CustomValues, input, mode);
  if (errors.length > 0) {
    throw new UnprocessableEntityException({
      error: 'CUSTOM_FIELDS_INVALID',
      message: 'Hay campos personalizados inválidos',
      details: errors,
    });
  }
  return values;
}

@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService) {}

  findAll(entity?: CustomFieldEntity, includeInactive = false) {
    return this.prisma.customFieldDefinition.findMany({
      where: { entity, ...(!includeInactive && { active: true }) },
      orderBy: [{ entity: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async create(data: {
    entity: CustomFieldEntity;
    key: string;
    label: string;
    type: CustomFieldType;
    options?: string[];
    required?: boolean;
    sortOrder?: number;
  }) {
    this.assertOptions(data.type, data.options);
    return this.prisma.customFieldDefinition.create({ data: { ...data, tenantId: requireTenantId() } });
  }

  // The type and key stay fixed so stored values keep their meaning.
  async update(id: string, data: { label?: string; options?: string[]; required?: boolean; active?: boolean; sortOrder?: number }) {
    const definition = await this.prisma.customFieldDefinition.findUnique({ where: { id } });
    if (!definition) throw new NotFoundException({ error: 'CUSTOM_FIELD_NOT_FOUND', message: 'Campo no encontrado' });
    if (data.options) this.assertOptions(definition.type, data.options);
    return this.prisma.customFieldDefinition.update({ where: { id }, data });
  }

  private assertOptions(type: CustomFieldType, options?: string[]) {
    if (type === CustomFieldType.select && !options?.length) {
      throw new UnprocessableEntityException({ error: 'CUSTOM_FIELD_OPTIONS_REQUIRED', message: 'Una lista necesita opciones' });
    }
    if (type !== CustomFieldType.select && options?.length) {
      throw new UnprocessableEntityException({ error: 'CUSTOM_FIELD_OPTIONS_NOT_ALLOWED', message: 'Solo las listas tienen opciones' });
    }
  }
}
