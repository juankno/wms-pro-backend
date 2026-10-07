import { HttpException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { effectivePermissions, Permission } from '../auth/permissions';
import { AuthUser } from '../common/types/request-with-user.interface';
import { JobContext, JobRegistry, PermanentJobError } from '../jobs/job-registry';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { PRIVATE_STORAGE, type ObjectStorage } from '../uploads/storage/object-storage';
import { ImportKind, ImportsService, MAX_ASYNC_IMPORT_ROWS } from './imports.service';
import { errorReportCsv, FORMAT_CONTENT_TYPES, ImportFormat } from './spreadsheet';

export const IMPORT_JOB = 'imports.run';

export const REQUIRED_PERMISSION: Record<ImportKind, Permission> = {
  products: 'products.write',
  locations: 'locations.manage',
  stock: 'stock.adjust',
};

export interface ImportJobPayload {
  kind: ImportKind;
  format: ImportFormat;
  fileKey: string;
  fileName: string;
}

export interface ImportJobResult {
  kind: ImportKind;
  fileName: string;
  total: number;
  created?: number;
  updated?: number;
  errors?: number;
  // First errors, for a quick look without downloading the report
  errorSample?: { line: number; message: string }[];
  errorReportKey?: string;
}

const ERROR_SAMPLE_SIZE = 20;

const importsPrefix = (tenantId: string) => `private/tenants/${tenantId}/imports/`;

@Injectable()
export class ImportJobsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private imports: ImportsService,
    private jobs: JobsService,
    private registry: JobRegistry,
    @Inject(PRIVATE_STORAGE) private storage: ObjectStorage,
  ) {}

  onModuleInit() {
    this.registry.register<ImportJobPayload>(IMPORT_JOB, {
      maxAttempts: 2,
      handler: (payload, context) => this.process(payload, context),
    });
  }

  async enqueue(kind: ImportKind, file: { buffer: Buffer; originalname?: string }, format: ImportFormat, user: AuthUser) {
    const fileKey = `${importsPrefix(requireTenantId())}${randomUUID()}.${format}`;
    await this.storage.put(fileKey, file.buffer, FORMAT_CONTENT_TYPES[format]);
    const payload: ImportJobPayload = { kind, format, fileKey, fileName: file.originalname || `importacion.${format}` };
    return this.jobs.enqueue(IMPORT_JOB, payload, { createdById: user.id });
  }

  async errorReport(jobId: string, user: AuthUser): Promise<{ content: Buffer; fileName: string }> {
    const job = await this.jobs.findById(jobId, user);
    const result = job.result as ImportJobResult | null;
    if (job.type !== IMPORT_JOB || !result?.errorReportKey) {
      throw new NotFoundException({ error: 'REPORT_NOT_FOUND', message: 'Este trabajo no tiene reporte de errores' });
    }
    const baseName = result.fileName.replace(/\.[^.]+$/, '');
    return { content: await this.storage.get(result.errorReportKey), fileName: `${baseName}-errores.csv` };
  }

  // Runs as the user who uploaded the file, with the permissions they have now.
  private async process(payload: ImportJobPayload, context: JobContext): Promise<ImportJobResult> {
    const job = await this.prisma.job.findUniqueOrThrow({ where: { id: context.jobId }, select: { createdById: true } });
    const user = await this.authUserOf(job.createdById);
    if (!user.permissions.includes(REQUIRED_PERMISSION[payload.kind])) {
      throw new PermanentJobError('El usuario que solicitó la importación ya no tiene permiso para hacerla');
    }
    const base = { kind: payload.kind, fileName: payload.fileName };

    await context.progress(5, 'Leyendo el archivo');
    const content = await this.storage.get(payload.fileKey).catch(() => {
      throw new PermanentJobError('El archivo subido ya no está disponible; vuelve a importarlo');
    });
    const rows = await this.imports.readRows(payload.kind, content, payload.format, MAX_ASYNC_IMPORT_ROWS).catch((error: unknown) => {
      throw this.permanent(error);
    });

    await context.progress(25, `Validando ${rows.length} filas`);
    const plan = await this.imports.validateAll(payload.kind, rows, user).catch((error: unknown) => {
      throw this.permanent(error);
    });

    if (plan.errors.length > 0) {
      const errorReportKey = payload.fileKey.replace(/\.\w+$/, '-errores.csv');
      await this.storage.put(errorReportKey, Buffer.from(errorReportCsv(rows, plan.errors)), FORMAT_CONTENT_TYPES.csv);
      await this.storage.delete(payload.fileKey);
      throw new PermanentJobError(`El archivo tiene ${plan.errors.length} errores; no se importó nada`, {
        ...base,
        total: rows.length,
        errors: plan.errors.length,
        errorSample: plan.errors.slice(0, ERROR_SAMPLE_SIZE),
        errorReportKey,
      } satisfies ImportJobResult);
    }

    await context.progress(60, `Guardando ${rows.length} filas`);
    await plan.apply();
    await this.storage.delete(payload.fileKey);
    return { ...base, total: rows.length, created: plan.created, updated: plan.updated };
  }

  private async authUserOf(userId: string | null): Promise<AuthUser> {
    const user = userId
      ? await this.prisma.user.findFirst({ where: { id: userId, active: true }, include: { customRole: true } })
      : null;
    if (!user) throw new PermanentJobError('El usuario que solicitó la importación ya no está activo');
    return {
      id: user.id,
      sub: user.id,
      tenantId: user.tenantId,
      username: user.username,
      name: user.name,
      role: user.role,
      warehouseId: user.warehouseId,
      permissions: effectivePermissions(user.role, user.customRole?.permissions),
    };
  }

  // Client errors (invalid file, warehouse not allowed) cannot be fixed by retrying.
  private permanent(error: unknown): unknown {
    if (error instanceof HttpException && error.getStatus() < 500) {
      const response = error.getResponse() as { message?: string };
      return new PermanentJobError(response.message ?? error.message);
    }
    return error;
  }
}
