// Offline mode (27 Nov 2026): what the counter did with no internet is sent up later, one step at a time, through the same
// routes it would have called online, so every rule (role, menu, tax, drawer, stock, Bookr) is checked as usual. While a
// step runs, this module tells those routes three things only the replay knows:
// - the time it happened (so its shift day, print day and stock moves are those of the outage, not of the sync);
// - the numbers already printed on paper (offline bill and receipt numbers, KOT labels), which are kept;
// - a marker row that goes into the route's own batch, so a step sent twice is saved once.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface OfflineStep {
  /** When it happened on the counter (ms). */
  at: number;
  deviceId: string;
  /** The device's letter (A, B, ...). */
  letter: string;
  /** KOT labels printed offline, by station id or name: { 'Kitchen': 'A2' }. */
  kotLabels?: Record<string, string>;
  /** The bill number printed offline (C261126A001). */
  billNo?: string;
  /** The receipt number printed offline (RCPT/26-27/A001). */
  receiptNo?: string;
}

const store = new AsyncLocalStorage<OfflineStep>();
/** The offline step being sent up, inside a replayed request; null for every ordinary request. */
export const offlineStep = (): OfflineStep | null => store.getStore() ?? null;

// The clock routes read (Date.now, through now() and clock()): the step's own time while it is replayed, else the real
// time. Only requests started by runOffline see another time.
const realNow = Date.now.bind(Date);
Date.now = () => store.getStore()?.at ?? realNow();
export const realTime = () => realNow();

export const runOffline = <T>(step: OfflineStep, fn: () => Promise<T>) => store.run(step, fn);

/**
 * The database as a replayed route sees it: the first write it makes (a batch, or a single run) also writes `marker`, the
 * step's own row, so the step and what it wrote are saved together or not at all. Reads pass straight through.
 */
export function markedDb(db: D1Database, marker: D1PreparedStatement): { db: D1Database; used: () => boolean } {
  let used = false;
  const real = new WeakMap<object, D1PreparedStatement>();
  const unwrap = (s: D1PreparedStatement) => real.get(s) ?? s;
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => {
    const w = new Proxy(s, {
      get(target, prop) {
        if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === 'run') return async () => {
          if (used) return target.run();
          used = true;
          return (await db.batch([target, marker]))[0];
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    real.set(w, s);
    return w;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (q: string) => wrap(target.prepare(q));
      if (prop === 'batch') return async (list: D1PreparedStatement[]) => {
        const plain = list.map(unwrap);
        if (used || !plain.length) return target.batch(plain);
        used = true;
        const out = await target.batch([...plain, marker]);
        return out.slice(0, plain.length);
      };
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxy, used: () => used };
}

/** The day part of an offline bill number for a billing name's letter: C + 261126 + A + 001. */
export const offlineBillPattern = (prefix: string, yymmdd: string, letter: string) => new RegExp(`^${escapeRe(prefix)}${yymmdd}${letter}\\d{3}$`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
