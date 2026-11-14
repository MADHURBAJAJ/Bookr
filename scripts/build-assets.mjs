// Builds the browser files for deploy (approved 15 Nov 2026): public/ is copied to dist/, app.js and app.css are
// minified and given a name with their content's hash (assets/app.<hash>.js), and index.html points at them. A hashed
// file never changes, so browsers keep it for a year (see _headers) and ask again only when a deploy changes it.
// Run by `wrangler deploy` and `wrangler dev` (build.command in wrangler.jsonc, which serves dist/).
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { transform } from 'esbuild';

const SRC = 'public';
const OUT = 'dist';
rmSync(OUT, { recursive: true, force: true });
cpSync(SRC, OUT, { recursive: true });
rmSync(`${OUT}/app.js`);
rmSync(`${OUT}/app.css`);
mkdirSync(`${OUT}/assets`, { recursive: true });

const hashed = async (file, loader) => {
  const code = (await transform(readFileSync(`${SRC}/${file}`, 'utf8'), { loader, minify: true, legalComments: 'none', target: 'es2022' })).code;
  const name = `assets/${file.replace(/\.(\w+)$/, `.${createHash('sha256').update(code).digest('hex').slice(0, 10)}.$1`)}`;
  writeFileSync(`${OUT}/${name}`, code);
  return name;
};
const js = await hashed('app.js', 'js');
const css = await hashed('app.css', 'css');

let index = readFileSync(`${SRC}/index.html`, 'utf8');
if (!index.includes('href="/app.css"') || !index.includes('src="/app.js"')) throw new Error('index.html no longer links /app.css and /app.js');
index = index.replace('href="/app.css"', `href="/${css}"`).replace('src="/app.js"', `src="/${js}"`);
writeFileSync(`${OUT}/index.html`, index);

writeFileSync(`${OUT}/_headers`, `${readFileSync(`${SRC}/_headers`, 'utf8').trimEnd()}
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);
console.log(`Built ${OUT}/: /${js}, /${css}`);
