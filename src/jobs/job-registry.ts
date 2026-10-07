import { Injectable } from '@nestjs/common';

export interface JobContext {
  jobId: string;
  tenantId: string;
  attempt: number;
  // 0-100; also renews the worker's lock on the job
  progress(percent: number, message?: string): Promise<void>;
}

export type JobHandler<P = unknown> = (payload: P, context: JobContext) => Promise<unknown>;

export interface JobDefinition<P = unknown> {
  handler: JobHandler<P>;
  // Attempts before the job is marked failed
  maxAttempts?: number;
}

// Thrown by handlers for errors a retry cannot fix (invalid input, missing data).
export class PermanentJobError extends Error {}

@Injectable()
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();

  register<P>(type: string, definition: JobDefinition<P>): void {
    if (this.definitions.has(type)) throw new Error(`Job type already registered: ${type}`);
    this.definitions.set(type, definition as JobDefinition);
  }

  get(type: string): JobDefinition | undefined {
    return this.definitions.get(type);
  }

  has(type: string): boolean {
    return this.definitions.has(type);
  }
}
