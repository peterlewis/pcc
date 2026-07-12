// build.mjs — compile PCC Web into a self-contained static site under ../docs for
// GitHub Pages. Bundles all JS into one inline classic <script> and inlines the CSS,
// so the result works over https (Pages) AND from a double-clicked file:// URL, with
// zero external network requests. Run: node web/build.mjs
import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const web = dirname(fileURLToPath(import.meta.url));
const docs = resolve(web, '..', 'docs');
const kb = (s) => Math.round(s / 1024);

// 0. Compile the firmware WASM (emu/clock-fw.mjs) FROM SOURCE with emscripten, so the shipped
//    emulator can never drift from the clock4 firmware. CI installs emsdk + checks out the
//    web/emu/firmware submodule; locally it uses your emcc + the submodule (or the dev worktree).
//    The build is byte-deterministic (verified: identical output run-to-run).
const fwOut = resolve(web, 'emu', 'clock-fw.mjs');
const hasEmcc = (() => { try { execSync('emcc --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
if (hasEmcc) {
  console.log('[fw] emcc → emu/clock-fw.mjs (compiling firmware from source)');
  execSync('bash build.sh', { cwd: resolve(web, 'emu', 'phase1'), stdio: 'inherit' });
} else if (existsSync(fwOut)) {
  console.warn('[fw] emcc not found — using the existing emu/clock-fw.mjs (install emscripten to rebuild from source)');
} else {
  console.error('[fw] FATAL: no emcc and no prebuilt emu/clock-fw.mjs. Install emscripten and run: git submodule update --init web/emu/firmware');
  process.exit(1);
}

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

// The emcc SINGLE_FILE firmware (emu/clock-fw.mjs) carries a Node code path (import node:module etc.)
// guarded at runtime by ENVIRONMENT_IS_NODE — dead in the browser, but esbuild still can't RESOLVE
// node:* when bundling an IIFE. Stub them to an inert module so the browser bundle builds; the wasm is
// inlined (SINGLE_FILE) so nothing here is actually needed at runtime in the browser.
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export const createRequire = () => (() => ({})); export default {};',
      loader: 'js',
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
  plugins: [stripQuery, stubNodeBuiltins],
  write: false,
});
const bundle = result.outputFiles[0].text;

// 2. Assemble index.html: inline base.css (fix ../fonts -> fonts) + inline the bundle.
//    IMPORTANT: pass a REPLACEMENT FUNCTION (not a string) to every .replace() that injects
//    inlined content. A string replacement interprets `$&`, `$$`, `` $` ``, `$'`, `$n` — and the
//    minified bundle DOES contain sequences like `$&&` (a var named `$` next to `&&`), so a string
//    replacement expands `$&` into the matched <script> tag, splicing a literal </script> into the
//    JS. That truncates the inline <script> in the browser → the whole app dies → raw {{…}} render.
//    A function's return value is used verbatim, with zero `$`-pattern interpretation.
let html = readFileSync(resolve(web, 'index.html'), 'utf8');
const css = readFileSync(resolve(web, 'css/base.css'), 'utf8').replace(/\.\.\/fonts\//g, 'fonts/');
html = html.replace(/<link rel="stylesheet" href="css\/base\.css(?:\?v=\d+)?">/, () => `<style>\n${css}\n</style>`);
// pcc-tokens.css (design-return tokens) — inline it too, AFTER base.css so its :root additions win.
const tokens = readFileSync(resolve(web, 'css/pcc-tokens.css'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/pcc-tokens\.css(?:\?v=\d+)?">/, () => `<style>\n${tokens}\n</style>`);
if (/href="css\/pcc-tokens\.css/.test(html)) throw new Error('pcc-tokens.css link not inlined');
const scriptRe = /<script type="module" src="js\/app-controller\.js(?:\?v=\d+)?"><\/script>/;
if (!scriptRe.test(html)) throw new Error('module <script> tag not found in index.html');
// Defence in depth: neutralise any literal `</script` in the bundle BEFORE inlining — inside a JS
// string/template/regex `<\/script` is byte-for-byte equivalent at runtime, but the HTML parser no
// longer sees a tag-closer, so it can never truncate the inline <script>. Zero occurrences today
// (verified), but this makes the whole class of bug impossible if source ever emits the literal.
const safeBundle = bundle.replace(/<\/script/gi, '<\\/script');
html = html.replace(scriptRe, () => `<script>\n${safeBundle}\n</script>`);
// Balanced-tag guard: the HTML parser closes the inline <script> at the FIRST `</script`, so the
// opener and closer counts must match exactly. Any surplus `</script` means a truncation bug got in.
const opens = (html.match(/<script[ >]/g) || []).length, closes = (html.match(/<\/script/g) || []).length;
if (opens !== closes) throw new Error(`inline <script> truncation: ${opens} <script> vs ${closes} </script> — a </script> leaked into the bundle`);

// 3. Emit docs/ — the deployable tree.
rmSync(docs, { recursive: true, force: true });
mkdirSync(docs, { recursive: true });
writeFileSync(resolve(docs, 'index.html'), html);
writeFileSync(resolve(docs, '.nojekyll'), ''); // Pages: don't run Jekyll over our files
for (const dir of ['fonts', 'globe', 'data']) {
  const src = resolve(web, dir);
  if (existsSync(src)) cpSync(src, resolve(docs, dir), { recursive: true });
}

// 3b. Emulator runtime binaries fetched at runtime by the app (the firmware .mjs/.wasm are bundled
//     via SINGLE_FILE, but these are streamed): the firmware IANA tz engine (tzrules.bin) and the
//     ZoneDetect map (tzmap.bin, Git LFS). Without these the app's timezone engine silently falls
//     back to browser Intl. (The old standalone emu/clock-emu.html demo page is gone — the app's
//     clock faces ARE the emulator.)
mkdirSync(resolve(docs, 'emu'), { recursive: true });
for (const bin of ['tzrules.bin', 'tzmap.bin', 'stars.bin']) {
  const src = resolve(web, 'emu', bin);
  if (existsSync(src)) { cpSync(src, resolve(docs, 'emu', bin)); console.log(`copied docs/emu/${bin} (${kb(statSync(src).size)} KB)`); }
  else console.warn(`WARN: web/emu/${bin} missing — the deployed tz engine will fall back to browser Intl`);
}

// 3c. Build provenance for the DEVICE→UPDATES "FIRMWARE & DATA" panel: firmware version string
//     (parsed from the submodule's version.c), the exact submodule commit the WASM was compiled
//     from, build time, emcc version, tz data sizes. Written to docs/ (deployed) AND web/ (so a
//     local dev server serves the same panel after any build; the web/ copy is gitignored).
const fwDir = resolve(web, 'emu', 'firmware');
const sh = (cmd, cwd) => { try { return execSync(cmd, { cwd, encoding: 'utf8' }).trim(); } catch { return ''; } };
const verC = (() => { try { return readFileSync(resolve(fwDir, 'mk4-time', 'Core', 'Src', 'version.c'), 'utf8'); } catch { return ''; } })();
const verD = (() => { try { return readFileSync(resolve(fwDir, 'mk4-date', 'Core', 'Src', 'version.c'), 'utf8'); } catch { return ''; } })();
const buildInfo = {
  version: ((verC.match(/VERSION_STRING\s+"([^"]+)"/) || [])[1] || 'unknown').trim(),
  dateVersion: ((verD.match(/VERSION_STRING\s+"([^"]+)"/) || [])[1] || '').trim(),  // date board versions on its own train (0.0.1→0.0.2)
  fwSha: sh('git rev-parse HEAD', fwDir),
  fwBranch: sh('git config -f .gitmodules submodule.web/emu/firmware.branch', resolve(web, '..')) || 'rollup',
  builtAt: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  emcc: hasEmcc ? ((sh('emcc --version').match(/\d+\.\d+\.\d+(?:-\w+)?/) || [])[0] || '') : '',
  tzrules: existsSync(resolve(web, 'emu', 'tzrules.bin')) ? statSync(resolve(web, 'emu', 'tzrules.bin')).size : 0,
  tzmap: existsSync(resolve(web, 'emu', 'tzmap.bin')) ? statSync(resolve(web, 'emu', 'tzmap.bin')).size : 0,
};
writeFileSync(resolve(docs, 'build-info.json'), JSON.stringify(buildInfo, null, 1));
writeFileSync(resolve(web, 'build-info.json'), JSON.stringify(buildInfo, null, 1));
console.log(`build-info: ${buildInfo.version}${buildInfo.dateVersion ? ' (date ' + buildInfo.dateVersion.replace(/^Version /, '') + ')' : ''} · clock4 @ ${buildInfo.fwSha.slice(0, 7)} (${buildInfo.fwBranch})`);

// 4. Report + guard against any external reference sneaking into index.html.
// The page must make zero external network REQUESTS (src=, <link href>, imports). A plain <a href>
// is user-clicked navigation, not a fetch — strip anchor tags before scanning so links (e.g. the
// pccd release download panel) don't trip the guard.
const scanned = html.replace(/<a\s[^>]*>/gi, '<a>');
const external = [...scanned.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+/gi)].map((m) => m[0]);
console.log(`built docs/index.html (${kb(html.length)} KB, bundle ${kb(bundle.length)} KB)`);
console.log(`assets: ${['fonts', 'globe', 'data'].filter((d) => existsSync(resolve(docs, d))).join(', ')}`);
if (external.length) { console.error('WARNING external refs in index.html:', external); process.exit(1); }
console.log('OK — no external references in index.html');
