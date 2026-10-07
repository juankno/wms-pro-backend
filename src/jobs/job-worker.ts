import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Job, JobStatus, Prisma } from '@prisma/client';
import { jobsConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { runInTenant } from '../tenancy/tenant-context';
import { JobContext, JobRegistry, PermanentJobError } from './job-registry';

const BASE_RETRY_DELAY_MS = 5_000;
const MAX_ERROR_LENGTH = 2_000;

// Exponential backoff between attempts: 5s, 10s, 20s…
export const retryDelayMs = (attempt: number) => BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);

@Injectable()
export class JobWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobWorker.name);
  private readonly config = jobsConfig();
  private timer: NodeJS.Timeout | null = null;
  private running = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private prisma: PrismaService,
    private registry: JobRegistry,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.worker) return;
    this.logger.log(`Worker de trabajos activo (concurrencia ${this.config.concurrency})`);
    this.schedule(0);
  }

  async onApplicationShutdown() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled(this.running);
  }

  // Claims and runs the jobs that are due; returns how many ran. Tests call it directly.
  async runOnce(limit = this.config.concurrency): Promise<number> {
    const jobs = await this.claim(limit);
    await Promise.all(jobs.map((job) => this.process(job)));
    return jobs.length;
  }

  private schedule(delay: number) {
    if (this.stopping) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick() {
    const free = this.config.concurrency - this.running.size;
    let claimed: Job[] = [];
    try {
      claimed = free > 0 ? await this.claim(free) : [];
    } catch (error) {
      this.logger.error(`No se pudieron tomar trabajos: ${errorMessage(error)}`);
    }
    for (const job of claimed) {
      const run = this.process(job).finally(() => this.running.delete(run));
      this.running.add(run);
    }
    this.schedule(claimed.length > 0 ? 0 : this.config.pollMs);
  }

  // A running job whose lock expired belongs to a worker that died, so it is claimed again.
  // Prisma stores UTC in columns without time zone, so times are compared against now() in UTC,
  // not in the session time zone.
  private claim(limit: number): Promise<Job[]> {
    const lockSeconds = this.config.lockSeconds;
    return this.prisma.$queryRaw<Job[]>`
      -- cross-tenant: the worker serves every tenant and runs each job inside its tenant context
      UPDATE jobs SET
        status = 'running',
        attempts = attempts + 1,
        "lockedUntil" = (now() AT TIME ZONE 'UTC') + make_interval(secs => ${lockSeconds}),
        "startedAt" = coalesce("startedAt", now() AT TIME ZONE 'UTC')
      WHERE id IN (
        SELECT id FROM jobs
        WHERE (status = 'queued' AND "runAt" <= (now() AT TIME ZONE 'UTC'))
          OR (status = 'running' AND "lockedUntil" < (now() AT TIME ZONE 'UTC'))
        ORDER BY "runAt"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`;
  }

  private async process(job: Job): Promise<void> {
    const definition = this.registry.get(job.type);
    if (!definition) return this.finish(job, JobStatus.failed, { error: `Tipo de trabajo desconocido: ${job.type}` });
    if (job.attempts > job.maxAttempts) {
      return this.finish(job, JobStatus.failed, { error: job.error ?? 'Se agotaron los intentos' });
    }

    const context: JobContext = {
      jobId: job.id,
      tenantId: job.tenantId,
      attempt: job.attempts,
      progress: async (percent, message) => {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            progress: Math.min(100, Math.max(0, Math.round(percent))),
            progressMessage: message,
            lockedUntil: new Date(Date.now() + this.config.lockSeconds * 1000),
          },
        });
      },
    };

    try {
      const result = await runInTenant(job.tenantId, () => definition.handler(job.payload, context));
      await this.finish(job, JobStatus.completed, { result: (result ?? null) as Prisma.InputJsonValue, progress: 100, progressMessage: null });
    } catch (error) {
      const permanent = error instanceof PermanentJobError;
      if (!permanent && job.attempts < job.maxAttempts) {
        await this.prisma.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.queued,
            error: errorMessage(error),
            lockedUntil: null,
            runAt: new Date(Date.now() + retryDelayMs(job.attempts)),
          },
        });
        return;
      }
      this.logger.warn(`Trabajo ${job.type} ${job.id} falló: ${errorMessage(error)}`);
      await this.finish(job, JobStatus.failed, { error: errorMessage(error) });
    }
  }

  private async finish(job: Job, status: JobStatus, data: Prisma.JobUpdateInput) {
    await this.prisma.job.update({
      where: { id: job.id },
      data: { ...data, status, lockedUntil: null, finishedAt: new Date() },
    });
  }
}
