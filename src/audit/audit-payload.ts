const SENSITIVE_KEY = /password|token|secret|authorization/i;
const MAX_PAYLOAD_CHARS = 10_000;

export const REDACTED = '[REDACTED]';

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(inner)]),
    );
  }
  return value;
}

export function auditPayload(body: unknown): unknown {
  if (body === undefined || body === null || (typeof body === 'object' && Object.keys(body).length === 0)) {
    return undefined;
  }
  const serialized = JSON.stringify(redact(body));
  return serialized.length > MAX_PAYLOAD_CHARS ? { truncated: true, preview: serialized.slice(0, MAX_PAYLOAD_CHARS) } : JSON.parse(serialized);
}

const ACTION_BY_METHOD: Record<string, string> = {
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

export function auditAction(method: string): string | undefined {
  return ACTION_BY_METHOD[method.toUpperCase()];
}

// "/v1/products/:id/photos" → "products"
export function auditResource(routePath: string): string {
  const segments = routePath.split('/').filter((s) => s && !s.startsWith(':') && !/^v\d+$/.test(s));
  return segments[0] ?? 'unknown';
}
