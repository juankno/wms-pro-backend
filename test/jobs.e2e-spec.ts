import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { JobStatus, LocationType, Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { effectivePermissions } from '../src/auth/permissions';
import { AuthUser } from '../src/common/types/request-with-user.interface';
import { JobRegistry, PermanentJobError } from '../src/jobs/job-registry';
import { JobWorker } from '../src/jobs/job-worker';
import { JobsService } from '../src/jobs/jobs.service';
import { STOCK_INTEGRITY_JOB, StockIntegrityJob } from '../src/stock/stock-integrity.job';
import { currentTenantId } from '../src/tenancy/tenant-context';
import { createTestTenant, deleteTestTenant, scopedTo, testPrisma } from './support/tenancy';

describe('Background jobs (integration)', () => {
  const prisma = testPrisma();
  let tenantId: string;
  let registry: JobRegistry;
  let jobs: JobsService;
  let worker: JobWorker;
  let owner: AuthUser;
  let other: AuthUser;
  let supervisor: AuthUser;
  const calls: { type: string; tenantId: string | undefined; attempt: number }[] = [];
  let failuresLeft = 0;

  const authUser = (id: string, role: Role): AuthUser => ({
    id, sub: id, tenantId, username: id, name: id, role, warehouseId: null, permissions: effectivePermissions(role),
  });
  const jobOf = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });
  const enqueue = (type: string, payload: object = {}, user = owner) => jobs.enqueue(type, payload, { createdById: user.id });
  const makeDue = (id: string) => prisma.job.update({ where: { id }, data: { runAt: new Date(Date.now() - 1000) } });
  // Other test files never enqueue jobs, so a generous limit drains everything that is due.
  const drain = () => worker.runOnce(50);

  beforeAll(async () => {
    tenantId = (await createTestTenant(prisma)).id;
    const createUser = (username: string, role: Role) =>
      prisma.user.create({ data: { tenantId, username, email: `${username}@jobs.test`, name: username, password: 'x', role } });
    const [a, b, c] = await Promise.all([
      createUser('owner', Role.operator),
      createUser('other', Role.operator),
      createUser('boss', Role.supervisor),
    ]);
    owner = authUser(a.id, Role.operator);
    other = authUser(b.id, Role.operator);
    supervisor = authUser(c.id, Role.supervisor);
  });

  beforeEach(() => {
    registry = new JobRegistry();
    jobs = scopedTo(new JobsService(prisma, registry), () => tenantId);
    worker = new JobWorker(prisma, registry);
    calls.length = 0;
    failuresLeft = 0;
    registry.register('test.echo', {
      handler: async (payload, context) => {
        calls.push({ type: 'test.echo', tenantId: currentTenantId(), attempt: context.attempt });
        await context.progress(50, 'A mitad');
        if (failuresLeft > 0) {
          failuresLeft--;
          throw new Error('Falla temporal');
        }
        return { echo: payload };
      },
    });
    registry.register('test.invalid', {
      handler: () => Promise.reject(new PermanentJobError('Archivo inválido')),
    });
  });

  afterAll(async () => {
    await deleteTestTenant(prisma, tenantId);
    await prisma.$disconnect();
  });

  it('runs a job inside its tenant and stores the result', async () => {
    const job = await enqueue('test.echo', { value: 42 });

    await drain();

    expect(await jobOf(job.id)).toMatchObject({
      status: JobStatus.completed, progress: 100, attempts: 1, result: { echo: { value: 42 } }, lockedUntil: null,
    });
    expect(calls).toEqual([{ type: 'test.echo', tenantId, attempt: 1 }]);
  });

  it('enqueues inside the caller transaction', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await jobs.enqueue('test.echo', {}, { createdById: owner.id }, tx);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await prisma.job.count({ where: { tenantId, createdById: owner.id, status: JobStatus.queued } })).toBe(0);
  });

  it('retries a failed attempt later with backoff', async () => {
    failuresLeft = 1;
    const job = await enqueue('test.echo');

    await drain();
    const retried = await jobOf(job.id);
    expect(retried).toMatchObject({ status: JobStatus.queued, attempts: 1, error: 'Falla temporal' });
    expect(retried.runAt.getTime()).toBeGreaterThan(Date.now());

    expect(await drain()).toBe(0);
    await makeDue(job.id);
    await drain();
    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.completed, attempts: 2 });
  });

  it('fails after the last attempt', async () => {
    failuresLeft = 5;
    const job = await jobs.enqueue('test.echo', {}, { createdById: owner.id, maxAttempts: 2 });

    await drain();
    await makeDue(job.id);
    await drain();

    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.failed, attempts: 2, error: 'Falla temporal' });
  });

  it('does not retry permanent errors', async () => {
    const job = await enqueue('test.invalid');

    await drain();

    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.failed, attempts: 1, error: 'Archivo inválido' });
  });

  it('claims a job only once when workers compete', async () => {
    const job = await enqueue('test.echo');

    await Promise.all([drain(), new JobWorker(prisma, registry).runOnce(50)]);

    expect(calls).toHaveLength(1);
    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.completed, attempts: 1 });
  });

  it('claims again a running job whose worker died', async () => {
    const job = await enqueue('test.echo');
    await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.running, attempts: 1, lockedUntil: new Date(Date.now() - 1000) },
    });

    await drain();

    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.completed, attempts: 2 });
  });

  it('fails jobs of an unknown type without running them', async () => {
    const job = await prisma.job.create({ data: { tenantId, type: 'test.gone', createdById: owner.id } });

    await drain();

    expect(await jobOf(job.id)).toMatchObject({ status: JobStatus.failed, error: 'Tipo de trabajo desconocido: test.gone' });
  });

  it('refuses to enqueue an unknown type', async () => {
    await expect(enqueue('test.nope')).rejects.toThrow('Unknown job type: test.nope');
  });

  it('shows users their own jobs and jobs.manage every job', async () => {
    const mine = await enqueue('test.echo');
    const theirs = await enqueue('test.echo', {}, other);

    const ownList = await jobs.findAll({ page: 1, limit: 100 }, owner);
    const allList = await jobs.findAll({ page: 1, limit: 100 }, supervisor);

    expect(ownList.data.map((job) => job.id)).toContain(mine.id);
    expect(ownList.data.map((job) => job.id)).not.toContain(theirs.id);
    expect(allList.data.map((job) => job.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(ownList.data[0]).not.toHaveProperty('payload');
    await expect(jobs.findById(theirs.id, owner)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('retries a failed job and cancels a queued one', async () => {
    const failed = await enqueue('test.invalid');
    await drain();
    const queued = await enqueue('test.echo');

    await expect(jobs.retry(failed.id, owner)).resolves.toMatchObject({ status: JobStatus.queued, attempts: 0, error: null });
    await expect(jobs.cancel(queued.id, owner)).resolves.toMatchObject({ status: JobStatus.cancelled });
    await expect(jobs.cancel(queued.id, owner)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(jobs.retry(queued.id, other)).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('stock integrity check', () => {
    beforeEach(() => new StockIntegrityJob(registry, prisma).onModuleInit());

    it('reports the stock that breaks the invariants of the tenant', async () => {
      const warehouse = await prisma.warehouse.create({ data: { tenantId, code: 'INT', name: 'Integrity' } });
      const location = await prisma.location.create({ data: { tenantId, warehouseId: warehouse.id, code: 'INT-1', type: LocationType.bin } });
      const product = await prisma.product.create({ data: { tenantId, code: 'INT-P', name: 'P', category: 'c' } });
      await prisma.warehouseStock.create({ data: { tenantId, productId: product.id, warehouseId: warehouse.id, onHand: 2 } });
      await prisma.locationStock.create({
        data: { tenantId, productId: product.id, warehouseId: warehouse.id, locationId: location.id, quantity: 5 },
      });
      const job = await jobs.enqueue(STOCK_INTEGRITY_JOB, {}, { createdById: supervisor.id });

      await drain();

      expect(await jobOf(job.id)).toMatchObject({
        status: JobStatus.completed,
        result: { checked: 1, problems: [{ warehouse: 'INT', product: 'INT-P', issue: 'ubicaciones 5 > en estantería 2' }] },
      });
    });
  });
});
