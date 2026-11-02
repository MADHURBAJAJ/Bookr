import { parsePaise } from './money';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

export function fail(status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 502 | 503, message: string): never {
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

// Parses a rupee amount typed by a person ("2,45,000.50") into integer paise. See money.ts.
export function paise(data: Record<string, unknown>, key: string, label: string): number {
  const raw = data[key];
  const value = typeof raw === 'string' ? parsePaise(raw) : null;
  if (value === null) fail(400, `${label} must be an amount in rupees with up to 2 decimals.`);
  return value;
}

export function optionalPaise(data: Record<string, unknown>, key: string, label: string): number | null {
  const raw = data[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return null;
  return paise(data, key, label);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: string | undefined): v is string {
  return !!v && UUID.test(v);
}

export function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}
