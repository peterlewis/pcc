// build.mjs — compile PCC Web into a self-contained static site under ../docs for
// GitHub Pages. Bundles all JS into one inline classic <script> and inlines the CSS,
// so the result works over https (Pages) AND from a double-clicked file:// URL, with
// zero external network requests. Run: node web/build.mjs
import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = dirname(fileURLToPath(import.meta.url));
const docs = resolve(web, '..', 'docs');
const kb = (s) => Math.round(s / 1024);

// Dev builds carry `?v=N` cache-busters on the dynamic imports; strip the query so
// esbuild resolves the real files.
const stripQuery = {
  name: 'strip-query',
  setup(build) {
    build.onResolve({ filter: /\?v=\d+$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?v=\d+$/, '')),
    }));
  },
};

// 1. Bundle the app entry (pulls in dc-lite + the dynamic clockface/sim/charts/realdev
//    imports + serial/nmea) into one IIFE.
const result = await esbuild.build({
  entryPoints: [resolve(web, 'js/app-controller.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  legalComments: 'none',
  plugins: [stripQuery],
  write: false,
});
const bundle = result.outputFiles[0].text;

// 2. Assemble index.html: inline base.css (fix ../fonts -> fonts) + inline the bundle.
let html = readFileSync(resolve(web, 'index.html'), 'utf8');
const css = readFileSync(resolve(web, 'css/base.css'), 'utf8').replace(/\.\.\/fonts\//g, 'fonts/');
html = html.replace(/<link rel="stylesheet" href="css\/base\.css(?:\?v=\d+)?">/, `<style>\n${css}\n</style>`);
const scriptRe = /<script type="module" src="js\/app-controller\.js(?:\?v=\d+)?"><\/script>/;
if (!scriptRe.test(html)) throw new Error('module <script> tag not found in index.html');
html = html.replace(scriptRe, `<script>\n${bundle}\n</script>`);

// 3. Emit docs/ — the deployable tree.
rmSync(docs, { recursive: true, force: true });
mkdirSync(docs, { recursive: true });
writeFileSync(resolve(docs, 'index.html'), html);
writeFileSync(resolve(docs, '.nojekyll'), ''); // Pages: don't run Jekyll over our files
for (const dir of ['fonts', 'globe', 'data']) {
  const src = resolve(web, dir);
  if (existsSync(src)) cpSync(src, resolve(docs, dir), { recursive: true });
}

// 4. Report + guard against any external reference sneaking into index.html.
const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0]);
console.log(`built docs/index.html (${kb(html.length)} KB, bundle ${kb(bundle.length)} KB)`);
console.log(`assets: ${['fonts', 'globe', 'data'].filter((d) => existsSync(resolve(docs, d))).join(', ')}`);
if (external.length) { console.error('WARNING external refs in index.html:', external); process.exit(1); }
console.log('OK — no external references in index.html');
