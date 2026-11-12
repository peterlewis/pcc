// config_write_check.mjs — the clock writes its menu choices into config.txt itself.
// With "config_write = on", and only if no computer has enumerated since power-on, the firmware edits
// config.txt's own flash sectors: a value that fits is written where the old one stands, anything else
// becomes a new line at the end and the old line is blanked. The file may grow once, into the unused
// part of its last cluster, which is the one write to the directory. Every rewrite goes through a
// journal in the settings store, so a power cut loses nothing.
// The emulator has a small disk for this: a root-directory sector and data sectors in the same NOR
// model as the settings store, with config.txt laid out on it (in order, or scattered) and stale junk
// where a real card has it. This runs the plain cases, and then cuts the power at EVERY flash
// operation of a full sync and requires, after the reboot:
//   - every setting still has the menu's value (the store keeps a choice until the file holds it);
//   - every line the writer had no business with is still in the file, in order;
//   - every other directory entry is untouched and the settings file is still found;
//   - the sync, left to run, ends in the same place as the uninterrupted one.
// Run: node config_write_check.mjs
process.env.TZ = 'UTC';
const { default: factory } = await import('../clock-fw.mjs');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC = { CAL: 0, ASTRO: 1, DISP: 2, DIAG: 3, SYS: 4 };

async function clock(flash) {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const readConfig = w('emu_read_config');
  const ev = w('emu_menu_event', 'void', ['number']), layer = w('emu_menu_layer', 'number'), secOf = w('emu_menu_section', 'number');
  const rowPtr = w('emu_daterow', 'number');
  const eeReset = w('emu_ee_reset'), eeLoad = w('emu_ee_load'), eeCommit = w('emu_ee_commit', 'number'), dirty = w('emu_menu_dirty', 'number');
  const attach = w('emu_disk_attach', 'void', ['number', 'number', 'number', 'number']);
  const fileLen = w('emu_disk_file_len', 'number'), filePtr = w('emu_disk_file', 'number'), dirPtr = w('emu_disk_dir', 'number');
  const flSize = w('emu_flash_size', 'number')(), flExport = w('emu_flash_export', 'void', ['number']), flImport = w('emu_flash_import', 'void', ['number']);
  const cut = w('emu_flash_cut', 'void', ['number', 'number']), ops = w('emu_flash_op_count', 'number'), lost = w('emu_power_lost_now', 'number');
  const cwStep = w('emu_cw_step'), cwBusy = w('emu_cw_busy', 'number'), takeReload = w('emu_cw_take_reload', 'number');
  const uptime = w('emu_uptime', 'void', ['number']);
  const exStart = w('emu_menu_export_start'), exNext = w('emu_menu_export_next', 'string'), exPending = w('emu_menu_export_pending', 'number');
  const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };
  const back = () => { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } };
  w('emu_boot_cold', 'void', ['number'])(1794473100);     // 2026-11-12 08:45 UTC
  w('emu_usb_host', 'void', ['number'])(0);                 // on a charger
  if (flash) { const p = M._malloc(flSize); M.HEAPU8.set(flash, p); flImport(p); M._free(p); eeLoad(); }
  else eeReset();
  const c = {
    peek: w('emu_cfg_peek', 'number', ['string']),
    usb: w('emu_usb_host', 'void', ['number']), backing: w('emu_ee_backing', 'number'),
    cut, ops, lost, readConfig,
    attach(lines, alloc, frag = 0) {
      const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
      const p = M._malloc(bytes.length); M.HEAPU8.set(bytes, p); attach(p, bytes.length, alloc, frag); M._free(p);
      readConfig();
    },
    text() { const n = fileLen(), p = filePtr(); return new TextDecoder('latin1').decode(M.HEAPU8.subarray(p, p + n)); },
    size: fileLen,
    dir() { const p = dirPtr(); return M.HEAPU8.slice(p, p + 4096); },
    flash() { const p = M._malloc(flSize); flExport(p); const b = M.HEAPU8.slice(p, p + flSize); M._free(p); return b; },
    menuEdit(sec, label, presses) {
      back(); ev(EVT.S1); ev(EVT.REL);
      for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
      ev(EVT.S1); ev(EVT.REL);
      for (let h = 0; !row().startsWith(label) && h < 40; h++) ev(EVT.BTN1);
      const ok = row().startsWith(label);
      ev(EVT.S1); ev(EVT.REL); for (const p of presses) ev(p); ev(EVT.S1); ev(EVT.REL); back();
      return ok;
    },
    commit() { return dirty() ? eeCommit() : 0; },
    // The main loop, as far as this needs it: the writer's step, the store's save, a requested reload.
    // Runs until nothing is in progress, or the power has gone. Returns the number of passes.
    run(max = 6000) {
      uptime(20000);
      let quiet = 0, i = 0;
      for (; i < max && quiet < 4 && !lost(); i++) {
        cwStep();
        let did = cwBusy();
        if (dirty() && layer() === 0) { eeCommit(); did = 1; }
        if (takeReload()) { readConfig(); did = 1; }
        quiet = did ? 0 : quiet + 1;
      }
      return i;
    },
    stored() {                                           // how many choices the store still holds (this tells the firmware a computer is there: last thing to ask)
      exStart(); let n = -1;
      for (let i = 0; i < 300 && exPending(); i++) { const l = exNext(); const m = /^\$PMCFG,\d+,0,END,(\d+)\*/.exec(l || ''); if (m) n = Number(m[1]); }
      return n;
    },
  };
  return c;
}

// A config.txt of about 9.5 KB: three clusters, with the lines the menu will change spread through it,
// one of them (MODE_UNIX) lying across the boundary between the first and second cluster.
function configFile() {
  const L = ['# Precision Clock config', 'config_write = on', 'MODE_ISO8601_STD = enabled', 'page_ms = 2000'];
  const filler = (i) => `# note ${String(i).padStart(3, '0')} ${'-'.repeat(40)}`;
  let i = 0;
  const bytes = () => L.join('\r\n').length + 2;
  while (bytes() + 52 < 4096 - 9) L.push(filler(i++));
  L.push('MODE_UNIX = enabled');                           // starts 9 bytes or so before the boundary
  while (bytes() < 6000) L.push(filler(i++));
  L.push('freq_hold = off');
  while (bytes() < 9500) L.push(filler(i++));
  L.push('; the end');
  return L;
}
const untouched = (lines) => lines.filter((l) => !/^(page_ms|MODE_UNIX|freq_hold|brightness)\b/.test(l));
// The lines of `text` the writer had no business with, as a list: blanked lines and the padding gone
// (a line the writer adds at the start of a sector has the last sector's unused spaces in front of it).
const kept = (text) => text.split('\r\n').map((l) => l.trim()).filter((l) => l !== '' && !/^(page_ms|MODE_UNIX|freq_hold|brightness|tc_learn|tc_apply|tc_persist|# synced )/.test(l));
const lastOf = (text, key) => { const m = text.split('\r\n').filter((l) => l.replace(/ /g, '').toLowerCase().startsWith(key.toLowerCase() + '=')); return m.length ? m[m.length - 1].trimEnd() : null; };
const MENU = { page_ms: 2250, freq_hold: 1, 'MODE:MODE_UNIX': 0, tc_learn: 1, tc_apply: 1, tc_persist: 1 };
const menuHolds = (c) => Object.entries(MENU).filter(([k, v]) => c.peek(k) !== v).map(([k, v]) => `${k}=${c.peek(k)} (menu ${v})`);
function makeChoices(c) {
  c.menuEdit(SEC.DISP, 'PAGE', [EVT.BTN1]); c.menuEdit(SEC.DIAG, 'F HOLD', [EVT.BTN1]);
  c.menuEdit(SEC.CAL, 'UNIX', [EVT.BTN1]); c.menuEdit(SEC.DIAG, 'TEMPCO', [EVT.BTN1]);
  c.commit();
}

// ---- The plain case ------------------------------------------------------------------------------
const FILE = configFile();
let opsTotal = 0, finalText = '';
for (const frag of [0, 1]) {
  const tag = frag ? 'scattered clusters' : 'clusters in order';
  const c = await clock();
  c.attach(FILE, 3, frag);
  const dir0 = c.dir(), size0 = c.size();
  check(`${tag}: the file loads from the disk (${size0} bytes, page_ms ${c.peek('page_ms')})`, size0 > 9000 && size0 < 12288 && c.peek('page_ms') === 2000);
  makeChoices(c);
  check(`${tag}: the menu's choices are in force`, menuHolds(c).length === 0);
  const o0 = c.ops();
  c.run();
  if (!frag) opsTotal = c.ops() - o0;
  const t = c.text();
  if (!frag) finalText = t;
  check(`${tag}: page_ms is written where it stood (${lastOf(t, 'page_ms')})`, t.split('\r\n')[3] === 'page_ms = 2250');
  check(`${tag}: freq_hold is written where it stood (${JSON.stringify(lastOf(t, 'freq_hold'))})`, lastOf(t, 'freq_hold') === 'freq_hold = on');
  check(`${tag}: MODE_UNIX did not fit: a new line at the end, and the old one blanked`, lastOf(t, 'MODE_UNIX') === 'MODE_UNIX = disabled' && !/MODE_UNIX *= *enabled/.test(t));
  check(`${tag}: the three TEMPCOMP lines are added`, ['tc_learn', 'tc_apply', 'tc_persist'].every((k) => lastOf(t, k) === `${k} = on`));
  check(`${tag}: a line records it (${(t.match(/^# synced .*$/m) || [''])[0]})`, /^# synced 2026-11-12 08:4\d by the clock$/m.test(t));
  check(`${tag}: every other line is still there, in order`, JSON.stringify(kept(t)) === JSON.stringify(untouched(FILE)));
  check(`${tag}: the file now fills its three clusters, the gap spaces (${c.size()})`, c.size() === 3 * 4096 && /^ *$/.test(t.slice(t.lastIndexOf('\n') + 1)));
  const dir1 = c.dir();
  const E = 3 * 32, mine = (i) => (i >= E + 22 && i < E + 26) || (i >= E + 28 && i < E + 32);   // config.txt's time, date and size
  const sizeNow = dir1[E + 28] | (dir1[E + 29] << 8) | (dir1[E + 30] << 16);
  check(`${tag}: in the directory only config.txt's size and time changed (size ${sizeNow})`, dir0.every((x, i) => x === dir1[i] || mine(i)) && sizeNow === 3 * 4096 && dir1.slice(E + 22, E + 26).some((x, i) => x !== dir0[E + 22 + i]));
  check(`${tag}: every setting still has the menu's value (${menuHolds(c).join(', ') || 'yes'})`, menuHolds(c).length === 0);

  // A second change later: no more growing, so the directory is not written again.
  c.menuEdit(SEC.DISP, 'PAGE', [EVT.BTN1]); c.commit();
  const want = c.peek('page_ms');
  c.run();
  const t2 = c.text();
  check(`${tag}: a later change is written in place (${lastOf(t2, 'page_ms')}), and the directory is left alone`, lastOf(t2, 'page_ms') === `page_ms = ${want}` && c.dir().every((x, i) => x === dir1[i]));
  check(`${tag}: there is still one sync line`, (t2.match(/^# synced /mg) || []).length === 1);

  const n = await clock(c.flash());
  n.readConfig();
  check(`${tag}: after a power cycle the file alone gives the same settings`, n.peek('page_ms') === want && n.peek('freq_hold') === 1 && n.peek('MODE:MODE_UNIX') === 0 && n.peek('tc_persist') === 1);
  check(`${tag}: and the store holds nothing any more (${n.stored()})`, n.stored() === 0);
}

// ---- When it must not write ----------------------------------------------------------------------
{
  const c = await clock();
  c.attach(FILE, 3);
  c.usb(1); c.run(50); c.usb(0);                         // a computer was there at some point since power-on
  makeChoices(c);
  const before = c.text(), o0 = c.ops();
  c.run(600);
  check('a computer has enumerated since power-on: nothing is written, though it has gone again', c.text() === before && menuHolds(c).length === 0);
  check('...and the store keeps the choices', c.stored() === 6);
}
{
  const c = await clock();
  c.attach(FILE.filter((l) => l !== 'config_write = on'), 3);
  makeChoices(c);
  const before = c.text();
  c.run(600);
  check('without "config_write = on" nothing is written', c.text() === before && menuHolds(c).length === 0);
}
{
  // No room to grow: the file ends exactly at the end of its last cluster.
  const L = FILE.slice(); let pad = 3 * 4096 - (L.join('\r\n').length + 2);
  while (pad > 0) { const n = Math.min(pad, 80); L.splice(L.length - 1, 0, n >= 4 ? '#' + 'x'.repeat(n - 3) : ' '.repeat(Math.max(0, n - 2))); pad = 3 * 4096 - (L.join('\r\n').length + 2); }
  const c = await clock();
  c.attach(L, 3);
  check(`a file that fills its clusters exactly (${c.size()})`, c.size() === 3 * 4096);
  const dir0 = c.dir();
  makeChoices(c);
  c.run();
  const t = c.text();
  check('no room: the values that fit are still written in place', lastOf(t, 'page_ms') === 'page_ms = 2250' && lastOf(t, 'freq_hold') === 'freq_hold = on');
  check('no room: nothing is added, the old line is not blanked, and the directory is untouched', lastOf(t, 'MODE_UNIX') === 'MODE_UNIX = enabled' && lastOf(t, 'tc_learn') === null && c.dir().every((x, i) => x === dir0[i]));
  check('no room: every setting still has the menu\'s value', menuHolds(c).length === 0);
  check('no room: the store keeps what it could not write (MODE_UNIX and the three TEMPCOMP keys)', c.stored() === 4);
}
{
  // Room for one more line but not for three: MODE_UNIX's line goes in, TEMPCOMP's block does not, and
  // no part of it does. A setting of several keys is all there or not there.
  const L = FILE.slice(); let pad = 3 * 4096 - 40 - (L.join('\r\n').length + 2);
  while (pad > 0) { const n = Math.min(pad, 80); L.splice(L.length - 1, 0, n >= 4 ? '#' + 'y'.repeat(n - 3) : ' '.repeat(Math.max(0, n - 2))); pad = 3 * 4096 - 40 - (L.join('\r\n').length + 2); }
  const c = await clock();
  c.attach(L, 3);
  makeChoices(c);
  c.run();
  const t = c.text();
  check(`40 bytes of room (${3 * 4096 - (L.join('\r\n').length + 2)}): the one line that fits is added`, lastOf(t, 'MODE_UNIX') === 'MODE_UNIX = disabled');
  check('...and none of the three TEMPCOMP lines, not one or two of them', ['tc_learn', 'tc_apply', 'tc_persist'].every((k) => lastOf(t, k) === null));
  check('...every setting still has the menu\'s value, TEMPCOMP from the store', menuHolds(c).length === 0);
  const n = await clock(c.flash()); n.readConfig();
  check('...and after a power cycle too', menuHolds(n).length === 0 && n.stored() === 3);
}
{
  // The same file in a bigger cluster (the clock's are 16 KB): when the sector it ends in is full, the
  // file grows into the next one, and everything goes in.
  const L = FILE.slice(); let pad = 3 * 4096 - 40 - (L.join('\r\n').length + 2);
  while (pad > 0) { const n = Math.min(pad, 80); L.splice(L.length - 1, 0, n >= 4 ? '#' + 'z'.repeat(n - 3) : ' '.repeat(Math.max(0, n - 2))); pad = 3 * 4096 - 40 - (L.join('\r\n').length + 2); }
  const c = await clock();
  c.attach(L, 4, 1);
  makeChoices(c);
  c.run();
  const t = c.text();
  check(`a cluster with a sector to spare: the file grows twice, to ${c.size()}`, c.size() === 4 * 4096);
  check('...and every choice is written, the three TEMPCOMP lines together in the new sector', lastOf(t, 'MODE_UNIX') === 'MODE_UNIX = disabled' && t.indexOf('tc_learn = on\r\ntc_apply = on\r\ntc_persist = on\r\n') === 3 * 4096);
  check('...every other line still there, every setting the menu\'s', JSON.stringify(kept(t)) === JSON.stringify(kept(L.join('\r\n'))) && menuHolds(c).length === 0);
  const n = await clock(c.flash()); n.readConfig();
  check('...and after a power cycle the file alone gives them, the store empty', menuHolds(n).length === 0 && n.stored() === 0);
}
{
  // Brightness on AUTO: written as a value the parser reads as AUTO, in one rewrite.
  const c = await clock();
  c.attach([...FILE.slice(0, 5), 'brightness = 2000', ...FILE.slice(5)], 3);
  c.menuEdit(SEC.DISP, 'BRIGH', Array(12).fill(EVT.BTN2)); c.commit();
  check('the menu puts brightness on AUTO', c.peek('brightness') < 0);
  c.run();
  check(`AUTO: written as a value the parser reads as AUTO (${JSON.stringify(lastOf(c.text(), 'brightness'))})`, lastOf(c.text(), 'brightness') === 'brightness = -1' && c.peek('brightness') < 0);
  const n = await clock(c.flash()); n.readConfig();
  check('AUTO: and it is still AUTO after a power cycle', n.peek('brightness') < 0);
}

// ---- A power cut at every flash operation of the sync ---------------------------------------------
{
  const others = (d) => d.filter((_, i) => i < 3 * 32 || i >= 4 * 32);        // every directory entry but config.txt's
  let dirRef = null, bad = [], recovered = 0, tried = 0, dirGone = 0;
  // Two ways for an operation to be interrupted: an erase left as noise and a program half landed;
  // or the erase complete and the program not begun.
  for (let k = 0; k < 2 * opsTotal; k++) {
    const c = await clock();
    c.attach(FILE, 3, k & 1);
    if (!dirRef) dirRef = others(c.dir());
    makeChoices(c);
    c.cut(k >> 1, k & 1);
    c.run();
    if (!c.lost()) { bad.push(`cut ${k >> 1}/${k & 1}: the power never went`); break; }
    tried++;
    const fl = c.flash();
    if (new TextDecoder('latin1').decode(fl.subarray(16384 + 32, 16384 + 43)) !== 'SETTINGSBIN') dirGone++;   // the cut left the directory itself unreadable
    const n = await clock(fl);                           // power on again: the boot finishes an interrupted rewrite
    n.readConfig();
    const why = [];
    if (n.backing() !== 1) why.push('the settings file is not found');
    const held = menuHolds(n); if (held.length) why.push(`settings lost: ${held.join(', ')}`);
    if (JSON.stringify(kept(n.text())) !== JSON.stringify(untouched(FILE))) why.push('lines lost or damaged');
    if (!others(n.dir()).every((x, i) => x === dirRef[i])) why.push('another directory entry changed');
    n.run();                                             // and the sync, left alone, finishes
    const t = n.text();
    if (menuHolds(n).length) why.push('settings lost after the sync resumed');
    if (lastOf(t, 'page_ms') !== 'page_ms = 2250' || lastOf(t, 'freq_hold') !== 'freq_hold = on' || lastOf(t, 'MODE_UNIX') !== 'MODE_UNIX = disabled' ||
        !['tc_learn', 'tc_apply', 'tc_persist'].every((x) => lastOf(t, x) === `${x} = on`)) why.push('the resumed sync did not finish the file');
    if (JSON.stringify(kept(t)) !== JSON.stringify(untouched(FILE))) why.push('lines lost after the sync resumed');
    if (n.stored() !== 0) why.push('the store still holds choices at the end');
    if (why.length) bad.push(`cut ${k >> 1}/${k & 1}: ${why.join('; ')}`); else recovered++;
  }
  check(`the sync is ${opsTotal} flash operations; the power was cut at each one in turn, two ways (${tried} runs)`, opsTotal > 100 && tried === 2 * opsTotal);
  check(`after every cut: settings held, no line lost, directory intact, and the sync finished${bad.length ? ` — ${bad.length} FAILED, first: ${bad[0]}` : ''}`, bad.length === 0 && recovered === 2 * opsTotal);
  check(`${dirGone} of those cuts left the directory sector itself erased or half written, so the settings file could not be looked up: the rewrite was found on the chip without it`, dirGone >= 2);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
