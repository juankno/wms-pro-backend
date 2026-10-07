import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Job, JobStatus, Prisma } from '@prisma/client';
import { buildMeta, paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/request-with-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { requireTenantId } from '../tenancy/tenant-context';
import { JobRegistry } from './job-registry';

const DEFAULT_MAX_ATTEMPTS = 3;

const JOB_INCLUDE = { createdBy: { select: { id: true, name: true } } } satisfies Prisma.JobInclude;

// Listings leave out payload and result, which can be large.
const JOB_SUMMARY = {
  id: true,
  type: true,
  status: true,
  error: true,
  progress: true,
  progressMessage: true,
  attempts: true,
  maxAttempts: true,
  runAt: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.JobSelect;

const NOT_FOUND = { error: 'JOB_NOT_FOUND', message: 'Trabajo no encontrado' };

export interface EnqueueOptions {
  createdById?: string;
  runAt?: Date;
  maxAttempts?: number;
}

// Users see and act on their own jobs; jobs.manage reaches every job of the tenant.
const canManageAll = (user: AuthUser) => user.permissions.includes('jobs.manage');

@Injectable()
export class JobsService {
  constructor(
    private prisma: PrismaService,
    private registry: JobRegistry,
  ) {}

  // Pass the caller's transaction so the job only exists if the data it works on was committed.
  async enqueue(type: string, payload: object, options: EnqueueOptions = {}, db: Prisma.TransactionClient = this.prisma): Promise<Job> {
    const definition = this.registry.get(type);
    if (!definition) throw new Error(`Unknown job type: ${type}`);
    return db.job.create({
      data: {
        tenantId: requireTenantId(),
        type,
        payload,
        createdById: options.createdById,
        runAt: options.runAt,
        maxAttempts: options.maxAttempts ?? definition.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      },
    });
  }

  async findAll(opts: { type?: string; status?: JobStatus; page: number; limit: number }, user: AuthUser) {
    const where: Prisma.JobWhereInput = {
      type: opts.type,
      status: opts.status,
      createdById: canManageAll(user) ? undefined : user.id,
    };
    const [data, total] = await Promise.all([
      this.prisma.job.findMany({
        where,
        select: JOB_SUMMARY,
        orderBy: { createdAt: 'desc' },
        ...paginate(opts.page, opts.limit),
      }),
      this.prisma.job.count({ where }),
    ]);
    return { data, meta: buildMeta(total, opts.page, opts.limit) };
  }

  async findById(id: string, user: AuthUser) {
    const job = await this.prisma.job.findUnique({ where: { id }, include: JOB_INCLUDE });
    if (!job) throw new NotFoundException(NOT_FOUND);
    this.assertAccess(job, user);
    return job;
  }

  async retry(id: string, user: AuthUser) {
    return this.transition(id, user, JobStatus.failed, {
      status: JobStatus.queued,
      attempts: 0,
      error: null,
      progress: 0,
      progressMessage: null,
      runAt: new Date(),
      finishedAt: null,
    });
  }

  async cancel(id: string, user: AuthUser) {
    return this.transition(id, user, JobStatus.queued, { status: JobStatus.cancelled, finishedAt: new Date() });
  }

  private async transition(id: string, user: AuthUser, from: JobStatus, data: Prisma.JobUpdateManyMutationInput) {
    const job = await this.findById(id, user);
    const { count } = await this.prisma.job.updateMany({ where: { id, status: from }, data });
    if (count === 0) {
      throw new UnprocessableEntityException({
        error: 'JOB_INVALID_STATUS',
        message: `El trabajo está ${job.status}`,
      });
    }
    return this.findById(id, user);
  }

  private assertAccess(job: Pick<Job, 'createdById'>, user: AuthUser) {
    if (job.createdById !== user.id && !canManageAll(user)) {
      throw new ForbiddenException({ error: 'JOB_FORBIDDEN', message: 'No tienes acceso a este trabajo' });
    }
  }
}
