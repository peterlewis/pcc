// build.mjs — compile PCC Web into a self-contained static site under ../docs for
// GitHub Pages. Bundles all JS into one inline classic <script> and inlines the CSS,
// so the result works over https (Pages) AND from a double-clicked file:// URL, with
// zero external network requests. Run: node web/build.mjs
import esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

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

// ============================================================================
// 1b. THE DRIFT GATE — what stops the component layer rotting back into 1432
//     inline styles. The app HAS a design system; it lost coherence because
//     nothing stopped a new feature from hand-typing a panel box instead of
//     using one. These are RATCHETS: every number may fall freely, and the
//     build fails the moment one climbs. Migration stays incremental, but it
//     can only ever go one way.
//     When you drive a number down, lower its `max` here in the same commit —
//     the gate prints the new floor for you.
// ============================================================================
{
  const src = html;                                  // the authored file, pre-inlining
  const count = (re) => (src.match(re) || []).length;

  // Ceilings: hand-authored styling that a component already covers.
  const CEIL = [
    { key: 'inline style="',            max: 868, n: count(/style="/g),
      fix: 'use a component class from pcc-components.css' },
    { key: 'background:var(--panel)',   max: 27,   n: count(/background:var\(--panel\)/g),
      fix: 'this is the .mod chassis — use class="mod"' },
    { key: 'border:1px solid var(--line)', max: 20, n: count(/border:1px solid var\(--line\)/g),
      fix: 'this is the .mod / .rack edge — use the component' },
    { key: 'background:var(--strip)',   max: 14,   n: count(/background:var\(--strip\)/g),
      fix: 'this is the engraved header — use class="mod__strip"' },
    { key: 'var(--fs-body)  [prose budget]', max: 12, n: count(/var\(--fs-body\)/g),
      fix: 'sans prose is legal only in .lead — a readout is a value, a caption is .cap, a silkscreen is .mod__legend' },
  ];

  // Floor: you may not satisfy the ceilings by deleting components.
  const FLOOR = [{ key: 'class="  [components in use]', min: 628, n: count(/class="/g) }];

  const fail = [], slack = [];
  for (const r of CEIL) {
    if (r.n > r.max) fail.push(`  ${r.key}: ${r.n} > ceiling ${r.max}  (+${r.n - r.max})\n      → ${r.fix}`);
    else if (r.n < r.max) slack.push(`  ${r.key}: ${r.n} (ceiling ${r.max} — lower it)`);
  }
  for (const r of FLOOR) {
    if (r.n < r.min) fail.push(`  ${r.key}: ${r.n} < floor ${r.min}  (components were removed, not added)`);
    else if (r.n > r.min) slack.push(`  ${r.key}: ${r.n} (floor ${r.min} — raise it)`);
  }

  // Hard rule, not a ratchet: a silkscreen legend is two short lines. Any longer and it is
  // prose wearing a legend's clothes — which is exactly the habit the depth law removed.
  for (const m of src.matchAll(/class="mod__legend"[^>]*>([\s\S]*?)<\/div>/g)) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&#\d+;/g, '.').trim();
    if (text.length > 170) fail.push(`  .mod__legend is ${text.length} chars (max 170): "${text.slice(0, 60)}…"\n      → a legend states provenance in two short lines; move the rest into a .cap or drop it`);
  }

  if (fail.length) {
    console.error('\n[gate] DRIFT GATE FAILED — the composition regressed:\n' + fail.join('\n') +
      '\n\n  pcc-components.css exists so these do not have to be retyped.' +
      '\n  If a ceiling genuinely must rise, raise it deliberately and say why in the commit.\n');
    process.exit(1);
  }
  console.log('[gate] drift gate OK' + (slack.length ? ' — ratchets can tighten:\n' + slack.join('\n') : ''));
}
const css = readFileSync(resolve(web, 'css/base.css'), 'utf8').replace(/\.\.\/fonts\//g, 'fonts/');
html = html.replace(/<link rel="stylesheet" href="css\/base\.css(?:\?v=\d+)?">/, () => `<style>\n${css}\n</style>`);
// pcc-tokens.css (design-return tokens) — inline it too, AFTER base.css so its :root additions win.
const tokens = readFileSync(resolve(web, 'css/pcc-tokens.css'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/pcc-tokens\.css(?:\?v=\d+)?">/, () => `<style>\n${tokens}\n</style>`);
if (/href="css\/pcc-tokens\.css/.test(html)) throw new Error('pcc-tokens.css link not inlined');
// pcc-components.css (the compositional layer: the rack + the depth law) — LAST, so its
// component classes can lean on every token above them.
const comps = readFileSync(resolve(web, 'css/pcc-components.css'), 'utf8');
html = html.replace(/<link rel="stylesheet" href="css\/pcc-components\.css(?:\?v=\d+)?">/, () => `<style>\n${comps}\n</style>`);
if (/href="css\/pcc-components\.css/.test(html)) throw new Error('pcc-components.css link not inlined');
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

// 2c. Bake the build stamp into the page itself. A long-lived tab survives a pccd overlay
//     refresh (files swap on disk under it) and keeps running stale JS with no way to know;
//     the app compares this baked stamp against the SERVED build-info.json and offers a
//     reload when they differ. Dev serving of raw web/ has no stamp → the check stays off.
const BUILT_AT = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
html = html.replace(/<meta charset="utf-8">/i, (m) => m + `\n<script>window.__PCC_BUILT=${JSON.stringify(BUILT_AT)};</script>`);

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
  builtAt: BUILT_AT,   // must equal the page's baked window.__PCC_BUILT — the stale-tab check compares them
  emcc: hasEmcc ? ((sh('emcc --version').match(/\d+\.\d+\.\d+(?:-\w+)?/) || [])[0] || '') : '',
  tzrules: existsSync(resolve(web, 'emu', 'tzrules.bin')) ? statSync(resolve(web, 'emu', 'tzrules.bin')).size : 0,
  tzmap: existsSync(resolve(web, 'emu', 'tzmap.bin')) ? statSync(resolve(web, 'emu', 'tzmap.bin')).size : 0,
};
writeFileSync(resolve(docs, 'build-info.json'), JSON.stringify(buildInfo, null, 1));
writeFileSync(resolve(web, 'build-info.json'), JSON.stringify(buildInfo, null, 1));
console.log(`build-info: ${buildInfo.version}${buildInfo.dateVersion ? ' (date ' + buildInfo.dateVersion.replace(/^Version /, '') + ')' : ''} · clock4 @ ${buildInfo.fwSha.slice(0, 7)} (${buildInfo.fwBranch})`);

// 3d. App manifest — a SHA256SUMS-style listing of every served file, so a bundled pccd can pull a
//     newer app straight from Pages and verify it (shasum -c) without cutting a full release. The
//     manifest's OWN hash is the app's identity: the daemon diffs it to decide whether to refresh, then
//     `shasum -c` gates the swap. Walk docs/ so the list is exactly what ships; exclude the manifest
//     itself and .nojekyll (a Pages directive the local daemon doesn't serve). Paths are relative and
//     '/'-joined; the daemon re-validates every path (no '..', no leading '/') before trusting it.
const APP_MANIFEST = 'app-manifest.sha256';
const walkFiles = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = resolve(dir, e.name);
  return e.isDirectory() ? walkFiles(p, base) : [p.slice(base.length + 1).split('\\').join('/')];
});
const appFiles = walkFiles(docs).filter((rel) => rel !== APP_MANIFEST && rel !== '.nojekyll').sort();
const appManifest = appFiles.map((rel) =>
  `${createHash('sha256').update(readFileSync(resolve(docs, rel))).digest('hex')}  ${rel}`).join('\n') + '\n';
writeFileSync(resolve(docs, APP_MANIFEST), appManifest);
writeFileSync(resolve(web, APP_MANIFEST), appManifest);   // web/ copy so a dev -w server carries it too
console.log(`app-manifest: ${appFiles.length} files, id ${createHash('sha256').update(appManifest).digest('hex').slice(0, 12)}`);

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
