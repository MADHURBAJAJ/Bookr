// Makes the phone app icons from the Bookr mark (approved 20 Nov 2026: Bookr installable on Android).
//   npx tsx scripts/make-app-icons.ts
// icon-192.png and icon-512.png: the mark as on the tab. icon-maskable-512.png: full-bleed teal with the B inside the
// middle 60%, so Android can crop it to a circle or a rounded square without cutting the letter.
import { writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const B = 'M10 7h7.2c3.8 0 5.8 1.9 5.8 4.7 0 1.9-1.1 3.2-2.7 3.7 2.1.4 3.5 1.9 3.5 4.2 0 3.3-2.2 5.4-6.2 5.4H10zm3.8 3.1v4h3c1.6 0 2.4-.7 2.4-2s-.8-2-2.4-2zm0 7v4.8h3.4c1.8 0 2.7-.8 2.7-2.4s-.9-2.4-2.7-2.4z';
const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0F766E"/><path fill="#fff" fill-rule="evenodd" d="${B}"/></svg>`;
// The letter spans about 10..24 x 7..25 of 32: scaled to 0.6 around the centre it stays inside the maskable safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0F766E"/><g transform="translate(16 16) scale(0.6) translate(-16.5 -16)"><path fill="#fff" fill-rule="evenodd" d="${B}"/></g></svg>`;

const png = (svg: string, size: number) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
writeFileSync('public/icon-192.png', png(plain, 192));
writeFileSync('public/icon-512.png', png(plain, 512));
writeFileSync('public/icon-maskable-512.png', png(maskable, 512));
console.log('Wrote public/icon-192.png, icon-512.png, icon-maskable-512.png');
