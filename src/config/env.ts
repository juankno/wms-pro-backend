const REQUIRED_VARIABLES = ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;
const SECRET_VARIABLES = ['JWT_SECRET', 'JWT_REFRESH_SECRET'] as const;
const MIN_PRODUCTION_SECRET_LENGTH = 32;
const PLACEHOLDER_PATTERN = /change|cambia|your-super-secret|^secret$/i;

const DURATION_UNITS_IN_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}". Use a number of seconds or a value like 15m, 1h, 30d.`);
  return Number(match[1]) * DURATION_UNITS_IN_SECONDS[match[2] || 's'];
}

export function validateEnv(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED_VARIABLES.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (env.NODE_ENV === 'production') {
    const weak = SECRET_VARIABLES.filter((name) => {
      const value = env[name]!;
      return value.length < MIN_PRODUCTION_SECRET_LENGTH || PLACEHOLDER_PATTERN.test(value);
    });
    if (weak.length) {
      throw new Error(
        `Insecure secrets for production (min ${MIN_PRODUCTION_SECRET_LENGTH} chars, no placeholders): ${weak.join(', ')}`,
      );
    }
  }

  parseDurationSeconds(env.JWT_EXPIRES_IN ?? '1h');
  parseDurationSeconds(env.JWT_REFRESH_EXPIRES_IN ?? '30d');
  mailConfig(env);
  jobsConfig(env);
}

const positiveInt = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};

// JOBS_WORKER=false keeps an API instance from running jobs (e.g. when a dedicated worker does).
export function jobsConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    worker: env.JOBS_WORKER !== 'false',
    concurrency: positiveInt(env, 'JOBS_CONCURRENCY', 2),
    pollMs: positiveInt(env, 'JOBS_POLL_MS', 1000),
    lockSeconds: positiveInt(env, 'JOBS_LOCK_SECONDS', 300),
  };
}

const MAIL_DRIVERS = ['log', 'smtp'] as const;
type MailDriver = (typeof MAIL_DRIVERS)[number];

export function mailConfig(env: NodeJS.ProcessEnv = process.env) {
  const driver = (env.MAIL_DRIVER ?? 'log') as MailDriver;
  if (!MAIL_DRIVERS.includes(driver)) throw new Error(`MAIL_DRIVER must be one of: ${MAIL_DRIVERS.join(', ')}`);
  if (driver === 'smtp' && !env.SMTP_URL) throw new Error('SMTP_URL is required when MAIL_DRIVER=smtp');
  return {
    driver,
    smtpUrl: env.SMTP_URL ?? '',
    from: env.MAIL_FROM ?? 'WMS Pro <no-reply@localhost>',
    appUrl: (env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  };
}

export function authConfig(env: NodeJS.ProcessEnv = process.env) {
  const accessSecret = env.JWT_SECRET;
  const refreshSecret = env.JWT_REFRESH_SECRET;
  if (!accessSecret || !refreshSecret) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be defined');
  }
  return {
    accessSecret,
    refreshSecret,
    accessTtlSeconds: parseDurationSeconds(env.JWT_EXPIRES_IN ?? '1h'),
    refreshTtlSeconds: parseDurationSeconds(env.JWT_REFRESH_EXPIRES_IN ?? '30d'),
  };
}
