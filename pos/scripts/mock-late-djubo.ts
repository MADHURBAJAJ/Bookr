// A mock to try in the browser (27 Nov 2026): a guest of five nights at ₹2,000, one Djubo booking per night (Djubo makes
// extensions as new bookings), paid ₹2,000 cash at the POS on nights 1, 2, 4 and 5 but not night 3, then all five marked
// paid in Djubo by reception at the end. Day close should ask for ₹2,000 (the night 3 money) and not close until its
// mode is picked. Invented names and amounts only. LOCAL ONLY: it refuses any address but localhost.
//
// On a Mac, from the repo folder (its own local database, nothing shared with the live POS):
//   npx wrangler d1 migrations apply DB --local -c pos/wrangler.jsonc --persist-to .wrangler/mock
//   npx wrangler dev -c pos/wrangler.jsonc --port 8788 --persist-to .wrangler/mock --var BOOKR_URL: \
//     --var POS_SETUP_TOKEN:mock-setup-token --var 'MAIL_ROUTES:{"bookings@mock.example.test":"0000dea0-0000-4000-8000-0000000000a7"}' \
//     --var 'BOOKING_MAIL_FROM:{"djubo":"notifications@mock-djubo.example.test"}'
//   npx tsx pos/scripts/mock-late-djubo.ts
// Then open http://localhost:8788 and sign in as mock-owner@example.test, password mock-password-123 (a local mock only).
const BASE = process.env.MOCK_URL ?? 'http://localhost:8788';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error('This mock runs only against a local POS (localhost).');
const BUSINESS = '0000dea0-0000-4000-8000-0000000000a7';
const TOKEN = 'mock-setup-token';
const OWNER = { email: 'mock-owner@example.test', password: 'mock-password-123' };
const FROM = 'notifications@mock-djubo.example.test';
const TO = 'bookings@mock.example.test';

class Client {
  cookies = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${BASE}/api${path}`, { method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), Origin: BASE, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const i = pair.indexOf('=');
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (v) this.cookies.set(k, v); else this.cookies.delete(k);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    return json;
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
}

const tr = (...cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const human = (d: string) => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}, ${d.slice(0, 4)}`;
let mailNo = 0;
/** A Djubo reservation mail in Djubo's layout, sent to the local POS's email handler. */
async function djubo(ref: string, checkIn: string, checkOut: string, advance: number, revised: boolean) {
  const n = ++mailNo;
  const stamp = `${human(checkIn)} 07:${String(n).padStart(2, "0")}`;
  const html = `<html><body><table>${[
    tr(`Reservation ID <h2>${ref}</h2>`, `Check in <b>${human(checkIn)}</b> 13:00 Check out <b>${human(checkOut)}</b> 11:00`),
    tr('Guest Name', ': Sample Stayer'), tr('Guest<br>Contact No.', ':<br>91-<br>9800077777'), tr('Type of Reservation:', 'Direct'),
    tr('S.No.', 'Rooms', 'Nights', 'Adults', 'Children', 'Infants', 'Meal Plan', 'Rooms<br>No.', 'Currency', 'Total Net Price'),
    tr('1', 'DELUXE', '1', '2', '0', '0', 'Room Only', 'XI', 'INR', '1,904.76'),
    tr('Rooms Rent', 'INR', '1,904.76'), tr('Total', 'INR', '1,904.76'), tr('Sub Total', 'INR', '1,904.76'), tr('Total Taxes', 'INR', '95.24'),
    ...(advance ? [tr('Advance Amount', 'INR', `${advance.toLocaleString('en-IN')}.00`)] : []),
    tr('Total outstanding amount', 'INR', `${(2000 - advance).toLocaleString('en-IN')}.00`),
    tr(`Created By: Sample Desk Created On: ${stamp}`), ...(revised ? [tr(`Modified By: Sample Desk Modified On: ${human(new Date().toISOString().slice(0, 10))} 09:4${n % 10}`)] : []),
  ].join('')}</table></body></html>`;
  const raw = [`From: ${FROM}`, `To: ${TO}`, `Subject: Reservation Confirmation${revised ? ' [Revised]' : ''} - SAMPLE HOSTEL - ${ref}`,
    `Message-ID: <mock-${ref}-${n}-${Date.now()}@example.test>`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', '', html, ''].join('\r\n');
  const res = await fetch(`${BASE}/cdn-cgi/handler/email?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`, { method: 'POST', body: raw });
  if (!res.ok) throw new Error(`Mail ${ref}: ${res.status} ${await res.text()}`);
}

const owner = new Client();
await owner.call('POST', '/setup', { businessId: BUSINESS, name: 'Sample Hostel (mock)', ownerName: 'Owner (mock)', ...OWNER }, { 'X-Setup-Token': TOKEN })
  .catch((e) => { if (!/exist|already|409/i.test(String(e))) throw e; throw new Error('The mock is already set up: delete .wrangler/mock and start again.'); });
await owner.post('/auth/login', OWNER);
const B = `/businesses/${BUSINESS}`;
const company = (await owner.post(`${B}/entities`, { name: 'Sample Hostels Pvt Ltd', kind: 'company', gstRegistered: true, gstin: '29ABCDE1234F1Z5', gstRateBp: 500, seriesPrefix: 'C' })).id;
await owner.post(`${B}/pay-accounts`, { name: 'Company QR', entityId: company });
const managerId = (await owner.post(`${B}/staff`, { name: 'Sample Manager', role: 'manager', pin: '9753', email: 'mock-manager@example.test', password: 'mock-manager-123' })).id;
const cashierId = (await owner.post(`${B}/staff`, { name: 'Sample Cashier', role: 'cashier', pin: '2468' })).id;
await owner.put(`${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] });
await owner.put(`${B}/bookings/auto`, { from: '2026-01-01' });
await owner.put(`${B}/bookings/booking-team`, { users: ['Sample Team'] });
const counter = new Client();
counter.cookies = new Map(owner.cookies);
await counter.post(`${B}/devices`, { name: 'Front desk (mock)' });
counter.cookies.delete('pos_session');
await counter.post('/auth/pin', { staffId: cashierId, pin: '2468' });
const mgr = { approverId: managerId, approverPin: '9753' };

const day = (await owner.get('/me')).business.shiftDay as string;
const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
const paidAtPos = [1, 2, 4, 5];
let stay = '';
let acc = '';
for (let n = 1; n <= 5; n++) {
  const ref = `MOCK00${n}`;
  await djubo(ref, plus(n - 5), plus(n - 4), 0, false);
  const bk = (await counter.get(`${B}/bookings/arrivals?day=${plus(n - 5)}`)).arrivals.find((a: any) => a.extRef === ref);
  if (!bk) throw new Error(`Booking ${ref} was not read from its mail.`);
  if (n === 1) {
    stay = (await counter.post(`${B}/stays`, { room: 'XI', guestName: 'Sample Stayer', phone: '9800077777', bookingId: bk.id, ...mgr })).id;
    acc = (await counter.get(`${B}/stays/${stay}/bill`)).stay.accountId;
  } else await counter.post(`${B}/bookings/${bk.id}/continue`, { stays: [{ id: stay }] });
  if (paidAtPos.includes(n)) await counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '2000' }] });
}
for (let n = 1; n <= 5; n++) await djubo(`MOCK00${n}`, plus(n - 5), plus(n - 4), 2000, true);

const sh = await owner.get(`${B}/shifts/${day}`);
const bill = await counter.get(`${B}/stays/${stay}/bill`);
console.log(`Mock ready on ${BASE}. Sign in as ${OWNER.email} / ${OWNER.password}.`);
console.log(`Sample Stayer in XI: rent ₹${bill.rentPaise / 100}, balance ₹${bill.balancePaise / 100}.`);
console.log(`Day close ${day} asks for: ${sh.summary.djubo.map((x: any) => `${x.extRef} ₹${x.amountPaise / 100}`).join(', ') || 'nothing'}.`);
