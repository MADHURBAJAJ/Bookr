import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export function fail(status: 400 | 401 | 403 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}

export async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const data = await c.req.json();
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  fail(400, 'Request body must be a JSON object.');
}

export function text(data: Record<string, unknown>, key: string, label: string, opts: { optional?: boolean; max?: number } = {}): string | null {
  const v = data[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (opts.optional) return null;
    fail(400, `${label} is required.`);
  }
  if (typeof v !== 'string') fail(400, `${label} must be text.`);
  const t = v.trim();
  if (t.length > (opts.max ?? 200)) fail(400, `${label} is too long.`);
  return t;
}

export function date(data: Record<string, unknown>, key: string, label: string): string {
  const v = text(data, key, label)!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z'))) fail(400, `${label} must be a date (YYYY-MM-DD).`);
  return v;
}

export function money(data: Record<string, unknown>, key: string, label: string): string {
  const raw = data[key];
  const v = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.replace(/,/g, '').trim() : '';
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(v)) fail(400, `${label} must be an amount with up to 2 decimals.`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string | undefined): v is string {
  return !!v && UUID.test(v);
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
