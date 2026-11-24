// The morning Daily check for the owner (25 Nov 2026), until a WhatsApp Business number is ready. Once a day, at a time
// that moves a little each day (DAILY_AT, give or take DAILY_JITTER minutes), the listener asks the POS for a one-time
// link to the last closed shift's Daily check, opens it in a hidden Chrome, saves it as a PDF and sends it to the owner's
// own number (DAILY_TO) with a short caption. Never more than once a shift, even after a restart; not after 2 pm.
// The send itself goes through src/whatsapp.js (sendDailyCheck), the only place that sends, under the guard's permit.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IST = 330 * 60_000;
/** India date and minutes since midnight. */
export const indiaNow = (ms) => { const d = new Date(ms + IST); return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }; };

/** Today's send time: the set time moved by a number of minutes from -jitter to +jitter, the same all day. */
export function sendMinute(date, atMinutes, jitter) {
  if (!jitter) return atMinutes;
  let h = 2166136261;
  for (const ch of date) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return atMinutes + (h % (2 * jitter + 1)) - jitter;
}

const LAST_MINUTE = 14 * 60;
const CHROME = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium'],
};
export const chromePath = (given) => given ?? (CHROME[process.platform] ?? []).find((p) => existsSync(p)) ?? null;

/** The PDF of the Daily check page, at phone width, one long page. */
export async function renderPdf(url, chrome) {
  const exe = chromePath(chrome);
  if (!exe) throw new Error('Chrome (or Edge) was not found on this computer: set CHROME_PATH in .env.');
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ['--no-first-run', '--disable-extensions', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 430, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
    await page.waitForFunction(() => document.body.dataset.ready, { timeout: 30_000 });
    const state = await page.evaluate(() => document.body.dataset.ready);
    if (state !== 'yes') throw new Error(`The Daily check page did not load: ${await page.evaluate(() => document.body.innerText.slice(0, 200))}`);
    const height = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
    return Buffer.from(await page.pdf({ width: '430px', height: `${height + 2}px`, printBackground: true, pageRanges: '1' }));
  } finally {
    await browser.close();
  }
}

/**
 * The daily sender. `wa()` gives the connection's handle (or null), `fetchImpl` and `render` are replaceable for tests.
 * tick() runs every minute; it sends when the time has come and today's report has not gone yet.
 */
export function createDaily({ cfg, log, wa, now = () => Date.now(), fetchImpl = fetch, render = renderPdf }) {
  const d = cfg.daily;
  const file = join(cfg.dataDir, 'daily-check.json');
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { sent: {}, tries: {} }; } };
  let busy = false;
  let timer = null;

  async function tick() {
    if (!d || busy) return;
    const { date, minutes } = indiaNow(now());
    const st = read();
    if (st.sent[date] || st.skipped === date) return;
    const at = sendMinute(date, d.atMinutes, d.jitter);
    if (minutes < at) return;
    if (minutes > LAST_MINUTE) {
      log.warn(`Daily check for the owner not sent today: the listener was not running between ${fmt(at)} and 2 pm.`);
      writeFileSync(file, JSON.stringify({ ...st, skipped: date }));
      return;
    }
    const tries = st.tries[date] ?? { n: 0, last: 0 };
    if (tries.n >= 5 || now() - tries.last < 10 * 60_000) return;
    const handle = wa();
    if (!handle?.canSend()) return;
    busy = true;
    try {
      const r = await fetchImpl(`${d.posUrl}/api/report/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: d.businessId, key: d.key }) });
      const link = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`the POS said ${r.status}: ${link.error ?? ''}`);
      const pdf = await render(link.url, d.chrome);
      await handle.sendDailyCheck(pdf, `Daily check ${link.day}.pdf`, link.caption);
      const after = read();
      after.sent[date] = { reportDay: link.day, at: now() };
      for (const k of Object.keys(after.sent).sort().slice(0, -40)) delete after.sent[k];   // keep the last 40 days
      after.tries = {};
      writeFileSync(file, JSON.stringify(after));
      log.info(`SENT the Daily check of ${link.day} to the owner (${pdf.length} bytes).`);
    } catch (e) {
      const after = read();
      after.tries[date] = { n: tries.n + 1, last: now() };
      writeFileSync(file, JSON.stringify(after));
      log.warn(`Daily check for the owner not sent (try ${tries.n + 1} of 5; again in 10 minutes): ${e.message}`);
    } finally {
      busy = false;
    }
  }
  const fmt = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  return {
    tick,
    start() { if (d && !timer) { timer = setInterval(() => void tick(), 60_000); log.info(`Daily check for the owner: on, about ${fmt(d.atMinutes)} each morning.`); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
