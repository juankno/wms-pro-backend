import { describe, expect, it } from 'vitest';
import { authConfig, parseDurationSeconds, validateEnv } from './env';

const strongSecret = 'a'.repeat(40);
const baseEnv = { DATABASE_URL: 'postgresql://x', JWT_SECRET: strongSecret, JWT_REFRESH_SECRET: `${strongSecret}b` };

describe('env', () => {
  it.each([
    ['3600', 3600],
    ['15m', 900],
    ['1h', 3600],
    ['30d', 2_592_000],
  ])('parses duration %s', (value, seconds) => {
    expect(parseDurationSeconds(value)).toBe(seconds);
  });

  it('rejects malformed durations', () => {
    expect(() => parseDurationSeconds('1 week')).toThrow();
  });

  it('requires database and JWT secrets', () => {
    expect(() => validateEnv({ DATABASE_URL: 'postgresql://x' })).toThrow(/JWT_SECRET/);
  });

  it('accepts short secrets outside production', () => {
    expect(() => validateEnv({ ...baseEnv, JWT_SECRET: 'dev' })).not.toThrow();
  });

  it.each(['short', 'change-me-in-production-change-me-in-production'])(
    'rejects weak production secret %s',
    (secret) => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production', JWT_SECRET: secret })).toThrow(/JWT_SECRET/);
    },
  );

  it('accepts strong production secrets', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).not.toThrow();
  });

  it('exposes token lifetimes in seconds', () => {
    expect(authConfig({ ...baseEnv, JWT_EXPIRES_IN: '15m' })).toMatchObject({
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
    });
  });
});
