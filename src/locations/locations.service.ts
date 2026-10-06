import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { assertWarehouseAccess } from '../common/utils/warehouse-scope';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { CreateLocationDto, GenerateLocationsDto, LocationQueryDto, UpdateLocationDto } from './dto/location.dto';
import { expandLevels, GeneratedLocation } from './location-generator';

const STORABLE_TYPES = new Set<LocationType>([LocationType.bin, LocationType.dock, LocationType.staging]);
const MAX_DEPTH = 20;
const GENERATION_TIMEOUT_MS = 30_000;

const WITH_CHILD_COUNT = { _count: { select: { children: true } } } as const;

@Injectable()
export class LocationsService {
  constructor(private prisma: PrismaService) {}

  async findAll(query: LocationQueryDto) {
    const where: Prisma.LocationWhereInput = {
      warehouseId: query.warehouseId,
      type: query.type,
      ...(query.parentId && { parentId: query.parentId === 'root' ? null : query.parentId }),
      ...(query.search && {
        OR: [
          { code: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        include: WITH_CHILD_COUNT,
        orderBy: [{ pickSequence: 'asc' }, { code: 'asc' }],
        ...paginate(query.page, query.limit),
      }),
      this.prisma.location.count({ where }),
    ]);
    return { data, meta: buildMeta(total, query.page, query.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const location = await this.prisma.location.findUnique({ where: { id }, include: WITH_CHILD_COUNT });
    if (!location) throw this.notFound();
    assertWarehouseAccess(user, location.warehouseId);
    return { ...location, path: await this.ancestors(location.parentId) };
  }

  async create(dto: CreateLocationDto, user: AuthUser) {
    assertWarehouseAccess(user, dto.warehouseId);
    await this.assertWarehouseExists(dto.warehouseId);
    if (dto.parentId) await this.findParent(dto.parentId, dto.warehouseId);
    return this.prisma.location.create({
      data: {
        ...dto,
        tenantId: requireTenantId(),
        code: dto.code.toUpperCase(),
        storable: dto.storable ?? STORABLE_TYPES.has(dto.type),
      },
    });
  }

  async update(id: string, dto: UpdateLocationDto, user: AuthUser) {
    const location = await this.findById(id, user);
    if (dto.parentId) {
      await this.findParent(dto.parentId, location.warehouseId);
      await this.assertNotDescendant(dto.parentId, id);
    }
    return this.prisma.location.update({
      where: { id },
      data: { ...dto, code: dto.code?.toUpperCase() },
    });
  }

  async delete(id: string, user: AuthUser) {
    const location = await this.findById(id, user);
    if (location._count.children > 0) {
      throw new ConflictException({
        error: 'LOCATION_HAS_CHILDREN',
        message: 'La ubicación tiene ubicaciones internas. Elimínalas o muévelas primero.',
      });
    }
    await this.prisma.location.delete({ where: { id } });
  }

  // Creates every missing node of the levels; codes that already exist are kept untouched.
  async generate(dto: GenerateLocationsDto, user: AuthUser) {
    assertWarehouseAccess(user, dto.warehouseId);
    await this.assertWarehouseExists(dto.warehouseId);
    const root = dto.parentId ? await this.findParent(dto.parentId, dto.warehouseId) : null;

    let nodes: GeneratedLocation[];
    try {
      nodes = expandLevels(dto.levels, root?.code ?? null);
    } catch (error) {
      throw new UnprocessableEntityException({ error: 'LOCATION_GENERATION_INVALID', message: (error as Error).message });
    }

    const created = await this.prisma.$transaction(
      async (tx) => {
        const { _max } = await tx.location.aggregate({
          where: { warehouseId: dto.warehouseId },
          _max: { pickSequence: true },
        });
        let sequence = _max.pickSequence ?? 0;
        const idsByCode = new Map<string, string>(root ? [[root.code, root.id]] : []);
        let count = 0;

        for (let depth = 0; depth < dto.levels.length; depth++) {
          const level = nodes.filter((node) => node.depth === depth);
          const result = await tx.location.createMany({
            data: level.map((node) => ({
              tenantId: requireTenantId(),
              warehouseId: dto.warehouseId,
              parentId: node.parentCode ? (idsByCode.get(node.parentCode) ?? null) : null,
              code: node.code,
              type: node.type,
              storable: STORABLE_TYPES.has(node.type),
              pickSequence: ++sequence,
            })),
            skipDuplicates: true,
          });
          count += result.count;
          const saved = await tx.location.findMany({
            where: { warehouseId: dto.warehouseId, code: { in: level.map((node) => node.code) } },
            select: { id: true, code: true },
          });
          saved.forEach((location) => idsByCode.set(location.code, location.id));
        }
        return count;
      },
      { timeout: GENERATION_TIMEOUT_MS },
    );

    return { created, skipped: nodes.length - created };
  }

  private async ancestors(parentId: string | null) {
    const path: { id: string; code: string; type: LocationType }[] = [];
    let currentId = parentId;
    while (currentId && path.length < MAX_DEPTH) {
      const parent = await this.prisma.location.findUnique({
        where: { id: currentId },
        select: { id: true, code: true, type: true, parentId: true },
      });
      if (!parent) break;
      path.unshift({ id: parent.id, code: parent.code, type: parent.type });
      currentId = parent.parentId;
    }
    return path;
  }

  private async assertNotDescendant(candidateParentId: string, id: string) {
    const chain = [candidateParentId, ...(await this.ancestors(candidateParentId)).map((node) => node.id)];
    if (chain.includes(id)) {
      throw new UnprocessableEntityException({
        error: 'LOCATION_CYCLE',
        message: 'Una ubicación no puede quedar dentro de sí misma',
      });
    }
  }

  private async findParent(parentId: string, warehouseId: string) {
    const parent = await this.prisma.location.findUnique({ where: { id: parentId } });
    if (!parent || parent.warehouseId !== warehouseId) {
      throw new NotFoundException({ error: 'PARENT_LOCATION_NOT_FOUND', message: 'Ubicación padre no encontrada en el almacén' });
    }
    return parent;
  }

  private async assertWarehouseExists(warehouseId: string) {
    const warehouse = await this.prisma.warehouse.findUnique({ where: { id: warehouseId } });
    if (!warehouse) throw new NotFoundException({ error: 'WAREHOUSE_NOT_FOUND', message: 'Almacén no encontrado' });
  }

  private notFound() {
    return new NotFoundException({ error: 'LOCATION_NOT_FOUND', message: 'Ubicación no encontrada' });
  }
}
