import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TENANT_TABLES = [
  'users',
  'warehouses',
  'products',
  'warehouse_stock',
  'stock_movements',
  'picking_orders',
  'packing_orders',
  'activity_logs',
  'audit_logs',
  'tenant_roles',
  'user_invitations',
];
const TENANT_FILTER = /"tenantId"|stockScopeCondition\(/;
const RAW_SQL = /\$(?:queryRaw|executeRaw)(?:<[^`]*?>)?`([\s\S]*?)`/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

// Raw SQL bypasses the tenant-scoped Prisma client, so it must filter by tenant itself.
describe('raw SQL tenant guard', () => {
  const statements = sourceFiles(join(__dirname, '..')).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(RAW_SQL)].map((match) => ({ file, sql: match[1] })),
  );
  const touchesTenantTable = (sql: string) =>
    TENANT_TABLES.some((table) => new RegExp(String.raw`\b(from|join|into|update)\s+"?${table}"?\b`, 'i').test(sql));

  it('finds the raw SQL statements', () => {
    expect(statements.length).toBeGreaterThan(5);
  });

  it('filters every statement on tenant tables by tenant', () => {
    const unscoped = statements.filter(({ sql }) => touchesTenantTable(sql) && !TENANT_FILTER.test(sql));

    expect(unscoped.map(({ file, sql }) => `${file}: ${sql.trim().split('\n')[0]}`)).toEqual([]);
  });
});
