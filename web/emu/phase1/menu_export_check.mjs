// menu_export_check.mjs — the menu's choices, sent as config.txt lines ($PMCFG).
// A choice made at the clock lived only in SETTINGS.BIN: config.txt could say one thing while the
// clock ran another. After every saved change, and on "menu_export = on", the clock now sends what
// the store holds in config.txt's own words, so a host (pccd) can write the lines into the file.
// This checks the sentences, and then the point of them: write the lines into config.txt, let the
// clock read it, and every stored choice is gone while every setting still has the menu's value.
// The file has become the one record, and a power cycle changes nothing.
// upsert() below is the reference for what the host does with a set; pccd does the same in C.
// Run: node menu_export_check.mjs
process.env.TZ = 'UTC';
const { default: factory } = await import('../clock-fw.mjs');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC = { CAL: 0, ASTRO: 1, DISP: 2, DIAG: 3, SYS: 4 };
const STORE_BYTES = 16384;

async function clock(store) {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const reg = w('emu_register_file', 'void', ['string', 'number', 'number']), fileMtime = w('emu_file_mtime', 'void', ['number', 'number']);
  const readConfig = w('emu_read_config');
  const ev = w('emu_menu_event', 'void', ['number']), layer = w('emu_menu_layer', 'number'), secOf = w('emu_menu_section', 'number');
  const rowPtr = w('emu_daterow', 'number'), peekStore = w('emu_ee_peek', 'number', ['number']), pokeStore = w('emu_ee_poke', 'void', ['number', 'number']);
  const eeReset = w('emu_ee_reset'), eeLoad = w('emu_ee_load'), eeCommit = w('emu_ee_commit', 'number'), dirty = w('emu_menu_dirty', 'number');
  const exStart = w('emu_menu_export_start'), exNext = w('emu_menu_export_next', 'string'), exPending = w('emu_menu_export_pending', 'number');
  const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };
  w('emu_boot_cold', 'void', ['number'])(1783627200);
  eeReset();
  if (store) { for (let i = 0; i < STORE_BYTES; i++) pokeStore(i, store[i]); eeLoad(); }
  const back = () => { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } };
  const c = {
    peek: w('emu_cfg_peek', 'number', ['string']),
    serial: w('emu_config_line', 'void', ['string']),
    usb: w('emu_usb_host', 'void', ['number']), busyNext: w('emu_cdc_busy_next', 'void', ['number']),
    exStart, exPending, file: null, at: 10,
    save(lines) {
      const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
      const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
      reg('/CONFIG.TXT', ptr, bytes.length); c.at++; fileMtime(c.at, c.at); readConfig();
      c.file = lines;
    },
    menuTap(sec, label, taps = 1) {
      back(); ev(EVT.S1); ev(EVT.REL);
      for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
      ev(EVT.S1); ev(EVT.REL);
      for (let h = 0; !row().startsWith(label) && h < 40; h++) ev(EVT.BTN1);
      const ok = row().startsWith(label);
      ev(EVT.S1); ev(EVT.REL); for (let t = 0; t < taps; t++) ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); back();
      return ok;
    },
    // EDIT, the given presses, then leave the editor and the menu.
    menuEdit(sec, label, presses) {
      back(); ev(EVT.S1); ev(EVT.REL);
      for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
      ev(EVT.S1); ev(EVT.REL);
      for (let h = 0; !row().startsWith(label) && h < 40; h++) ev(EVT.BTN1);
      ev(EVT.S1); ev(EVT.REL); for (const p of presses) ev(p); ev(EVT.S1); ev(EVT.REL); back();
    },
    commit() { return dirty() ? eeCommit() : 0; },
    // Run the sender until the set is out. Returns the raw lines.
    drain(max = 200) { const out = []; for (let i = 0; i < max && exPending(); i++) { const l = exNext(); if (l) out.push(l.trim()); } return out; },
    async powerCycle() {
      const bytes = new Uint8Array(STORE_BYTES);
      for (let i = 0; i < STORE_BYTES; i++) bytes[i] = peekStore(i);
      const n = await clock(bytes); n.at = c.at - 1; if (c.file) n.save(c.file); return n;
    },
  };
  return c;
}

// One $PMCFG set, parsed and checked. Returns { ok, gen, items: [[key, value]], why }.
function parseSet(lines) {
  const items = []; let gen = null, end = null;
  for (const l of lines) {
    const m = /^\$(PMCFG,[^*]*)\*([0-9A-F]{2})$/.exec(l);
    if (!m) return { ok: false, why: `not a $PMCFG sentence: ${l}` };
    let x = 0; for (const ch of m[1]) x ^= ch.charCodeAt(0);
    if (x !== parseInt(m[2], 16)) return { ok: false, why: `bad checksum: ${l}` };
    const f = m[1].split(',');
    if (f.length !== 5) return { ok: false, why: `expected 5 fields: ${l}` };
    if (gen === null) gen = f[1]; else if (gen !== f[1]) return { ok: false, why: 'the generation changed inside a set' };
    if (f[2] === '0') { if (f[3] !== 'END') return { ok: false, why: l }; end = Number(f[4]); }
    else { if (end !== null || Number(f[2]) !== items.length + 1) return { ok: false, why: `out of order: ${l}` }; items.push([f[3], f[4]]); }
  }
  if (end === null) return { ok: false, why: 'no END line' };
  if (end !== items.length) return { ok: false, why: `END says ${end}, ${items.length} lines came` };
  return { ok: true, gen: Number(gen), items };
}
// What a host does with a set: give each key its value in config.txt. A line for the key is
// rewritten in place (the first one; any later duplicates are dropped); a key with no line gets one
// at the end; an empty value removes the key's lines. Comments and everything else are untouched.
function upsert(lines, items) {
  let out = lines.slice();
  const keyOf = (l) => { const t = l.trim(); if (!t || t[0] === '#' || t[0] === ';') return null; const e = t.indexOf('='); return e < 0 ? null : t.slice(0, e).replace(/ /g, '').toLowerCase(); };
  for (const [key, value] of items) {
    const k = key.toLowerCase(); let done = false;
    out = out.flatMap((l) => { if (keyOf(l) !== k) return [l]; if (done || value === '') return []; done = true; return [`${key} = ${value}`]; });
    if (!done && value !== '') out.push(`${key} = ${value}`);
  }
  return out;
}

// ---- The sentences -------------------------------------------------------------------------------
{
  const c = await clock();
  c.usb(1);
  // freq_hold, the tempcomp trio and colon_balance are on by default: the file switches them off, so
  // that each menu tap below switches one on, as the export's expected lines say.
  c.save(['MODE_ISO8601_STD = enabled', 'MODE_UNIX = enabled', 'page_ms = 2000', '# a comment', 'brightness = 2000', 'seg_balance = 150',
    'colon_balance = off', 'freq_hold = off', 'tc_learn = off', 'tc_apply = off', 'tc_persist = off']);
  c.drain();
  c.exStart();
  let set = parseSet(c.drain());
  check(`an empty store sends an empty set (${set.ok ? `${set.items.length} lines` : set.why})`, set.ok && set.items.length === 0);

  check('PAGE found', c.menuTap(SEC.DISP, 'PAGE'));
  check('a change that is not saved yet sends nothing', c.exPending() === 0);
  check('saving it queues a set', c.commit() === 1 && c.exPending() === 1);
  set = parseSet(c.drain());
  check(`the set is one line: page_ms and the menu's value (${set.ok ? JSON.stringify(set.items) : set.why})`, set.ok && set.items.length === 1 && set.items[0][0] === 'page_ms' && Number(set.items[0][1]) === c.peek('page_ms'));

  c.menuTap(SEC.DIAG, 'F HOLD'); c.menuTap(SEC.CAL, 'UNIX'); c.menuTap(SEC.DIAG, 'TEMPCO'); c.menuTap(SEC.DISP, 'COLON');
  c.menuTap(SEC.DISP, 'BRIGH'); c.menuTap(SEC.DISP, 'BALANC'); c.menuTap(SEC.SYS, 'NMEA');
  c.commit();
  set = parseSet(c.drain());
  const got = set.ok ? Object.fromEntries(set.items) : {};
  check(`a full set parses (${set.ok ? `${set.items.length} lines` : set.why})`, set.ok && set.items.length === 11);
  check('a toggle: freq_hold = on', got.freq_hold === 'on');
  check('a mode, in config.txt\'s word: MODE_UNIX = disabled', got.MODE_UNIX === 'disabled');
  check('a setting of several keys sends each: tc_learn, tc_apply, tc_persist = on', got.tc_learn === 'on' && got.tc_apply === 'on' && got.tc_persist === 'on');
  check(`a named value: colon_mode = ${got.colon_mode}`, ['slowfade', 'heartbeat', 'sawtooth', 'alt_sawtooth', 'toggle', 'solid'].includes(got.colon_mode));
  check(`nmea = ${got.nmea}`, ['all', 'rmc', 'off'].includes(got.nmea));
  check(`brightness is written the way config.txt reads it (${got.brightness})`, /^\d+$/.test(got.brightness || ''));
  check(`BALANCE keeps the strength config.txt gave: seg_balance = ${got.seg_balance}, colon_balance = ${got.colon_balance}`, got.seg_balance === '150' && got.colon_balance === 'on');

  // A busy endpoint is retried and nothing is lost; no host, nothing is sent and nothing is left queued.
  c.exStart(); c.busyNext(7);
  const again = parseSet(c.drain(400));
  check('with the endpoint busy for a while, the same set still arrives whole', again.ok && JSON.stringify(again.items) === JSON.stringify(set.items));
  c.exStart(); c.usb(0);
  check('with no computer attached nothing is sent and the request is dropped', c.drain().length === 0 && c.exPending() === 0);
  c.usb(1); c.serial('menu_export = on');
  check('"menu_export = on" over serial asks for a set', c.exPending() === 1 && parseSet(c.drain()).ok);

  // ---- The point: write the lines into config.txt -------------------------------------------------
  const KEYS = ['page_ms', 'freq_hold', 'MODE:MODE_UNIX', 'tc_learn', 'tc_apply', 'tc_persist', 'colon_mode', 'brightness', 'seg_balance', 'colon_balance', 'nmea'];
  const before = Object.fromEntries(KEYS.map((k) => [k, c.peek(k)]));
  const written = upsert(c.file, set.items);
  check('the comment line is still in the file, and page_ms is rewritten where it stood', written.includes('# a comment') && written.indexOf(`page_ms = ${got.page_ms}`) === 2);
  c.save(written);
  const diff = KEYS.filter((k) => c.peek(k) !== before[k]).map((k) => `${k} ${before[k]}->${c.peek(k)}`);
  check(`after the host writes the lines, every setting still has the menu's value${diff.length ? ` (${diff.join(', ')})` : ''}`, diff.length === 0);
  c.commit();
  const after = parseSet(c.drain());
  check(`and the store has let every one of them go (${after.ok ? `${after.items.length} left` : after.why})`, after.ok && after.items.length === 0);
  const n = await c.powerCycle();
  const diff2 = KEYS.filter((k) => n.peek(k) !== before[k]).map((k) => `${k} ${before[k]}->${n.peek(k)}`);
  check(`a power cycle changes nothing: config.txt is now the one record${diff2.length ? ` (${diff2.join(', ')})` : ''}`, diff2.length === 0);
  n.usb(1); n.exStart();
  check('and the store is still empty after it', parseSet(n.drain()).items?.length === 0);
}

// ---- Brightness on AUTO has no value to write: the line is removed --------------------------------
{
  const c = await clock();
  c.usb(1);
  c.save(['MODE_ISO8601_STD = enabled', 'brightness = 2000']);
  c.menuEdit(SEC.DISP, 'BRIGH', Array(12).fill(EVT.BTN2));   // step down past zero: AUTO
  check(`the menu puts brightness on AUTO (${c.peek('brightness')})`, c.peek('brightness') < 0);
  c.commit();
  const set = parseSet(c.drain());
  check(`AUTO is sent as an empty value (${set.ok ? JSON.stringify(set.items) : set.why})`, set.ok && set.items.length === 1 && set.items[0][0] === 'brightness' && set.items[0][1] === '');
  const written = upsert(c.file, set.items);
  check('the host removes the brightness line', !written.some((l) => /brightness/.test(l)) && written.length === 1);
  c.save(written);
  check('brightness is still AUTO', c.peek('brightness') < 0);
  c.commit(); c.drain();
  const n = await c.powerCycle();
  check('and still AUTO after a power cycle', n.peek('brightness') < 0);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
