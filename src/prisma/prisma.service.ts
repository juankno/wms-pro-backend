import { PrismaClient } from '@prisma/client';
import { withTenantIsolation } from '../tenancy/tenant-isolation';

export function createPrismaClient(databaseUrl?: string): PrismaService {
  const client = new PrismaClient(databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined);
  return withTenantIsolation(client);
}

// Injection token and type for the tenant-scoped client built by createPrismaClient.
export abstract class PrismaService extends PrismaClient {}
