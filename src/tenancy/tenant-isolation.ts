import { currentTenantId } from './tenant-context';

// Prisma delegate names of tenant-owned models.
export const TENANT_SCOPED_DELEGATES = new Set<string>([
  'user',
  'warehouse',
  'product',
  'warehouseStock',
  'stockMovement',
  'pickingOrder',
  'packingOrder',
  'activityLog',
  'auditLog',
  'tenantRole',
  'userInvitation',
  'location',
  'locationStock',
  'partner',
]);

const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

type Args = { where?: object; data?: unknown; create?: object } | undefined;

export function scopeArgs(operation: string, args: Args, tenantId: string): Args {
  const scoped = { ...args };
  if (FILTERED_OPERATIONS.has(operation)) {
    scoped.where = { ...scoped.where, tenantId };
  } else if (operation === 'create') {
    scoped.data = { ...(scoped.data as object), tenantId };
  } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
    scoped.data = ([] as unknown[]).concat(scoped.data ?? []).map((row) => ({ ...(row as object), tenantId }));
  } else if (operation === 'upsert') {
    scoped.where = { ...scoped.where, tenantId };
    scoped.create = { ...scoped.create, tenantId };
  }
  return scoped;
}

function scopeDelegate(delegate: object): object {
  return new Proxy(delegate, {
    get(target, operation, receiver) {
      const method: unknown = Reflect.get(target, operation, receiver);
      if (typeof method !== 'function' || typeof operation !== 'string') return method;
      return (args?: Args) => {
        const tenantId = currentTenantId();
        const finalArgs = tenantId ? scopeArgs(operation, args, tenantId) : args;
        return (method as (a?: Args) => unknown).call(target, finalArgs);
      };
    },
  });
}

// Scopes tenant-owned models to the tenant of the current request. The tenant is read when a
// query is built (not when Prisma lazily runs it), so it survives Promise.all and deferred awaits.
// Queries outside a tenant context (login, token refresh, platform jobs) run unscoped.
export function withTenantIsolation<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string') return value;
      if (TENANT_SCOPED_DELEGATES.has(property) && value && typeof value === 'object') return scopeDelegate(value);
      if (property === '$transaction' && typeof value === 'function') {
        return (input: unknown, ...rest: unknown[]) =>
          typeof input === 'function'
            ? (value as (...a: unknown[]) => unknown).call(target, (tx: object) => (input as (t: object) => unknown)(withTenantIsolation(tx)), ...rest)
            : (value as (...a: unknown[]) => unknown).call(target, input, ...rest);
      }
      return value;
    },
  });
}
