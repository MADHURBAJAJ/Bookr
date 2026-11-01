// Draws the invented demo pages (register, expense list, cash summary) as PNG files in demo/images.
// They show the sample data from demo/sample-data.ts in a handwriting-style font. Run once:
//   npx tsx scripts/make-demo-images.ts
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { CASH_SUMMARY_31_OCT, EXPENSES_31_OCT, REGISTER_31_OCT } from '../demo/sample-data';

const FONT = 'Bradley Hand';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const sumRupees = (xs: string[]) => {
  const paise = xs.reduce((s, x) => { const [r, p = ''] = x.split('.'); return s + Number(r) * 100 + Number(p.padEnd(2, '0')); }, 0);
  return paise % 100 ? `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}` : String(paise / 100);
};

function page(title: string, header: string[], cols: number[], rows: string[][], footer: string[][], W = 1000) {
  const top = 150, lh = 46;
  const H = top + (rows.length + footer.length + 2) * lh + 60;
  const lines: string[] = [];
  const y0 = top + lh;
  header.forEach((h, i) => lines.push(`<text x="${cols[i]}" y="${top}" font-size="24" font-family="${FONT}" fill="#1d2b5a" font-weight="bold">${esc(h)}</text>`));
  rows.forEach((r, j) => r.forEach((cell, i) => lines.push(`<text x="${cols[i]}" y="${y0 + j * lh}" font-size="26" font-family="${FONT}" fill="#1d2b5a">${esc(cell)}</text>`)));
  footer.forEach((r, j) => r.forEach((cell, i) => lines.push(`<text x="${cols[i]}" y="${y0 + (rows.length + 1 + j) * lh}" font-size="27" font-family="${FONT}" fill="#1d2b5a" font-weight="bold">${esc(cell)}</text>`)));
  const rules = Array.from({ length: rows.length + footer.length + 3 }, (_, k) => `<line x1="40" x2="${W - 40}" y1="${top + 14 + k * lh}" y2="${top + 14 + k * lh}" stroke="#b9c7dd" stroke-width="1.5"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="100%" height="100%" fill="#fbf8ef"/>
    <line x1="110" x2="110" y1="0" y2="${H}" stroke="#e7a3a3" stroke-width="2"/>
    ${rules.join('')}
    <text x="40" y="70" font-size="34" font-family="${FONT}" fill="#1d2b5a" font-weight="bold">${esc(title)}</text>
    <text x="${W - 300}" y="70" font-size="20" font-family="Helvetica" fill="#9b2c2c">SAMPLE · INVENTED DATA</text>
    ${lines.join('')}
  </svg>`;
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: FONT }, fitTo: { mode: 'width', value: W } }).render().asPng();
}

const reg = REGISTER_31_OCT.map((r, i) => {
  const by = (m: string) => r.payments.filter((p) => p.mode === m).map((p) => p.amount).join('+');
  const upi = r.payments.filter((p) => p.mode === 'upi');
  return [String(i + 1), r.billNo, r.amount, r.billType === 'fnb' ? 'F&B' : 'Room', by('cash'),
    upi.filter((p) => p.columnLabel === 'UPI XOXO').map((p) => p.amount).join(''), upi.filter((p) => p.columnLabel === 'UPI Bank 2').map((p) => p.amount).join(''), by('card'), r.remarks ?? ''];
});
writeFileSync('demo/images/register-2026-10-31.png', page('Bill Register   31 / 10 / 26', ['#', 'Bill No', 'Amount', 'Type', 'Cash', 'UPI XOXO', 'UPI Bank 2', 'Card', 'Remarks'],
  [50, 120, 270, 380, 470, 570, 700, 840, 920], reg, [['', 'Total', sumRupees(REGISTER_31_OCT.map((r) => r.amount))]], 1120));

writeFileSync('demo/images/expenses-2026-10-31.png', page('Expenses   31 / 10 / 26', ['#', 'Item', 'Amount'], [50, 130, 700],
  EXPENSES_31_OCT.map((e, i) => [String(i + 1), e.narration, e.amount]), [['', 'Total', sumRupees(EXPENSES_31_OCT.map((e) => e.amount))]]));

const c = CASH_SUMMARY_31_OCT;
writeFileSync('demo/images/cash-summary-2026-10-31.png', page('Cash Account   31 / 10 / 26', ['', 'Particulars', 'Rs'], [50, 130, 700],
  [['', 'Opening balance', c.opening], ['', 'Received', c.received], ['', 'Balance', c.balance], ['', 'Expenses', c.expenses]], [['', 'Cash in hand', c.cashInHand]]));
console.log('Wrote demo/images/*.png');
