// build-export.mjs — produce ONE fully self-contained HTML file for handing to Claude Design
// to iterate on the UI. Unlike build.mjs (which copies fonts/data/globe alongside docs/), this
// inlines EVERYTHING — JS bundle, CSS, the 4 B612 fonts (base64), and the coastline JSON (via a
// tiny fetch shim) — so the result is a single file with zero external requests. The globe photo
// assets are intentionally omitted: the app renders a vector globe from the inlined coastline, so
// nothing at runtime loads them.
import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = dirname(fileURLToPath(import.meta.url));
const kb = (s) => Math.round(s / 1024);

// Dev builds carry ?v=N cache-busters on the dynamic imports; strip so esbuild resolves the files.
const stripQuery = {
  name: 'strip-query',
  setup(build) {
    build.onResolve({ filter: /\?v=\d+$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?v=\d+$/, '')),
    }));
  },
};

// 1. Bundle the app into one IIFE.
const result = await esbuild.build({
  entryPoints: [resolve(web, 'js/app-controller.js')],
  bundle: true, format: 'iife', minify: true, target: 'es2020', legalComments: 'none',
  plugins: [stripQuery], write: false,
});
const bundle = result.outputFiles[0].text;

// 2. CSS with the 4 B612 fonts inlined as base64 data URIs.
let css = readFileSync(resolve(web, 'css/base.css'), 'utf8');
for (const f of ['B612-Regular', 'B612-Bold', 'B612Mono-Regular', 'B612Mono-Bold']) {
  const b64 = readFileSync(resolve(web, 'fonts', `${f}.woff2`)).toString('base64');
  css = css.replace(new RegExp(`url\\(["']?\\.\\./fonts/${f}\\.woff2["']?\\)`, 'g'), `url("data:font/woff2;base64,${b64}")`);
}

// 3. Assemble index.html: inline CSS + a coastline-JSON fetch shim + the bundle.
let html = readFileSync(resolve(web, 'index.html'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/base\.css(?:\?v=\d+)?">/, `<style>\n${css}\n</style>`);

const land = readFileSync(resolve(web, 'data/land-110m.json'), 'utf8'); // valid JSON == valid JS literal
const shim = `<script>/* inlined coastline — serve it to the app's fetch offline */\n`
  + `window.__PCC_LAND__=${land};\n`
  + `(function(){var _f=window.fetch&&window.fetch.bind(window);window.fetch=function(u){`
  + `if(typeof u==='string'&&/land-110m\\.json/.test(u)){`
  + `return Promise.resolve(new Response(JSON.stringify(window.__PCC_LAND__),{headers:{'Content-Type':'application/json'}}));}`
  + `return _f?_f.apply(null,arguments):Promise.reject(new Error('offline'));};})();</script>`;

const scriptRe = /<script type="module" src="js\/app-controller\.js(?:\?v=\d+)?"><\/script>/;
if (!scriptRe.test(html)) throw new Error('module <script> tag not found in index.html');
html = html.replace(scriptRe, `${shim}\n<script>\n${bundle}\n</script>`);

// 4. Emit + verify no external requests remain.
mkdirSync(resolve(web, 'export'), { recursive: true });
const out = resolve(web, 'export/pcc-design-export.html');
writeFileSync(out, html);
const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0])
  .concat([...html.matchAll(/\b(?:src|href)\s*=\s*["'](?!data:|#)[^"']*\.(?:woff2?|jpg|png|json|js|css)["']/gi)].map((m) => m[0]));
console.log(`built export/pcc-design-export.html (${kb(html.length)} KB, single self-contained file)`);
if (external.length) { console.error('WARNING external refs:', external); process.exit(1); }
console.log('OK — zero external references; ready to hand to Claude Design.');
