import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { JobStatus, Role } from '@prisma/client';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { IMPORT_JOB, ImportJobResult, ImportJobsService } from '../src/imports/import-jobs.service';
import { ImportsService } from '../src/imports/imports.service';
import { JobRegistry } from '../src/jobs/job-registry';
import { JobWorker } from '../src/jobs/job-worker';
import { JobsService } from '../src/jobs/jobs.service';
import { LocalStorage } from '../src/uploads/storage/local-storage';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Background imports (integration)', () => {
  const prisma = testPrisma();
  const storageRoot = mkdtempSync(path.join(tmpdir(), 'wms-private-'));
  const storage = new LocalStorage(storageRoot, '/private');
  const registry = new JobRegistry();
  let tenantId: string;
  const jobs = scopedTo(new JobsService(prisma, registry), () => tenantId);
  const importJobs = scopedTo(new ImportJobsService(prisma, new ImportsService(prisma), jobs, registry, storage), () => tenantId);
  const worker = new JobWorker(prisma, registry);
  let admin: AuthUser;
  let operator: AuthUser;

  const authUser = (id: string, role: Role): AuthUser => ({
    id, sub: id, tenantId, username: id, name: id, role, warehouseId: null, permissions: effectivePermissions(role),
  });
  const storedFiles = () =>
    readdirSync(storageRoot, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  const runImport = async (content: Buffer, originalname: string, kind: 'products' | 'stock' = 'products', user = admin) => {
    const job = await importJobs.enqueue(kind, { buffer: content, originalname }, originalname.endsWith('.xlsx') ? 'xlsx' : 'csv', user);
    await worker.runOnce(50);
    return prisma.job.findUniqueOrThrow({ where: { id: job.id } });
  };
  const xlsx = async (rows: unknown[][]) => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Datos');
    rows.forEach((row) => sheet.addRow(row));
    return Buffer.from(await workbook.xlsx.writeBuffer());
  };

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    importJobs.onModuleInit();
    const [a, b] = await Promise.all([
      prisma.user.create({ data: { tenantId, username: 'imp-admin', email: 'a@imp.test', name: 'Admin', password: 'x', role: Role.admin } }),
      prisma.user.create({ data: { tenantId, username: 'imp-op', email: 'o@imp.test', name: 'Op', password: 'x', role: Role.operator } }),
    ]);
    admin = authUser(a.id, Role.admin);
    operator = authUser(b.id, Role.operator);
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it('imports an XLSX file in the background and removes the upload', async () => {
    const content = await xlsx([
      ['code', 'name', 'category', 'lotTracking'],
      ['XL-1', 'Tornillo', 'Ferretería', 'no'],
      ['XL-2', 'Leche', 'Lácteos', true],
    ]);

    const job = await runImport(content, 'productos.xlsx');

    expect(job).toMatchObject({
      type: IMPORT_JOB,
      status: JobStatus.completed,
      progress: 100,
      result: { kind: 'products', fileName: 'productos.xlsx', total: 2, created: 2, updated: 0 },
    });
    expect(await prisma.product.findMany({ where: { tenantId, code: { startsWith: 'XL-' } }, select: { code: true, lotTracking: true }, orderBy: { code: 'asc' } }))
      .toEqual([{ code: 'XL-1', lotTracking: false }, { code: 'XL-2', lotTracking: true }]);
    expect(storedFiles()).toEqual([]);
  });

  it('rejects the whole file and keeps a downloadable report of the bad rows', async () => {
    const csv = 'code,name,category\nOK-1,Bueno,X\n,Sin código,X\nOK-1,Repetido,X\n';

    const job = await runImport(Buffer.from(csv), 'lote.csv');
    const result = job.result as unknown as ImportJobResult;

    expect(job).toMatchObject({ status: JobStatus.failed, attempts: 1, error: 'El archivo tiene 2 errores; no se importó nada' });
    expect(result).toMatchObject({ total: 3, errors: 2 });
    expect(result.errorSample?.map((error) => error.line)).toEqual([3, 4]);
    expect(await prisma.product.count({ where: { tenantId, code: 'OK-1' } })).toBe(0);

    const report = await importJobs.errorReport(job.id, admin);
    expect(report.fileName).toBe('lote-errores.csv');
    const lines = report.content.toString().replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe('code,name,category,linea,error');
    expect(lines.slice(1, 3).map((line) => line.split(',')[3])).toEqual(['3', '4']);
    expect(storedFiles()).toEqual([expect.stringMatching(/-errores\.csv$/)]);
  });

  it('validates files with more rows than PostgreSQL accepts as query parameters', async () => {
    const rows = Array.from({ length: 33_000 }, (_, index) => `BULK-${index},Producto ${index},`);

    const job = await runImport(Buffer.from(['code,name,category', ...rows].join('\n')), 'masivo.csv');

    expect(job).toMatchObject({ status: JobStatus.failed, attempts: 1, result: { total: 33_000, errors: 33_000 } });
  });

  it('fails without retrying when the file cannot be read', async () => {
    const job = await runImport(Buffer.from('code,name,category\n'), 'vacio.csv');

    expect(job).toMatchObject({ status: JobStatus.failed, attempts: 1, error: 'El archivo no tiene filas' });
  });

  it('checks the permission of the user again when the job runs', async () => {
    await prisma.user.update({ where: { id: operator.id }, data: { role: Role.operator } });
    const job = await runImport(Buffer.from('code,name,category\nNP-1,X,X\n'), 'sin-permiso.csv', 'products', operator);

    expect(job).toMatchObject({ status: JobStatus.failed, error: 'El usuario que solicitó la importación ya no tiene permiso para hacerla' });
  });

  it('serves the report only to whoever can see the job', async () => {
    const failed = await runImport(Buffer.from('code,name,category\n,X,X\n'), 'otro.csv');
    const completed = await runImport(Buffer.from('code,name,category\nREP-1,X,X\n'), 'bien.csv');

    await expect(importJobs.errorReport(failed.id, operator)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(importJobs.errorReport(completed.id, admin)).rejects.toBeInstanceOf(NotFoundException);
  });
});
