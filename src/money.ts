// Rupee text → integer paise with string arithmetic only, so no floating-point value is involved.
// Accepts Indian or Western grouping ("2,45,000.50", "245,000.5"), a leading minus, up to 2 decimals.
export function parsePaise(text: string): number | null {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, '').trim());
  if (!m) return null;
  const value = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -value : value;
}
