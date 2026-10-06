export type LimitedResource = 'users' | 'warehouses' | 'ordersPerMonth';

/** null means unlimited. */
export type PlanLimits = Record<LimitedResource, number | null>;

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  trial: { users: 5, warehouses: 1, ordersPerMonth: 300 },
  starter: { users: 10, warehouses: 2, ordersPerMonth: 2_000 },
  pro: { users: 50, warehouses: 10, ordersPerMonth: 20_000 },
  enterprise: { users: null, warehouses: null, ordersPerMonth: null },
};

const RESOURCES: LimitedResource[] = ['users', 'warehouses', 'ordersPerMonth'];

// Plan defaults, overridden per tenant by settings.limits (e.g. a negotiated contract).
export function resolveLimits(plan: string, settings: unknown): PlanLimits {
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS.trial;
  const overrides = (settings as { limits?: Partial<Record<LimitedResource, unknown>> } | null)?.limits ?? {};
  return Object.fromEntries(
    RESOURCES.map((resource) => {
      const value = overrides[resource];
      const valid = value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
      return [resource, valid ? value : base[resource]];
    }),
  ) as PlanLimits;
}
