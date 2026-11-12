// menu_perkey_check.mjs — config.txt against the menu, one setting at a time.
// The old rule worked on the whole file: saving config.txt for any reason made every setting in it
// beat the menu's choice, and a beaten choice stayed in the store, to come back when its line was
// later removed. The rule now, per setting:
//   - the file does not mention it: the menu's choice applies;
//   - the file mentions it and that line has not changed since the last load: the menu's choice
//     still applies (editing the timezone no longer undoes a brightness set at the clock);
//   - that line is new or has changed: the file wins, and the menu's choice is deleted for good.
// A removed line never beats the menu. After any of it, a power cycle must change nothing.
// The comparison must also hold at power-on: a clock is often plugged into a computer, edited, and
// unplugged before it has looked at the file again. The store keeps what the file last said, beside
// every menu record, for that.
// This runs the firmware's real loader on an in-memory /CONFIG.TXT and drives the real menu. A power
// cycle is a fresh emulator given the old one's settings store, byte for byte.
// With the old code the "another line changes" and "does not come back" cases FAIL.
// Run: node menu_perkey_check.mjs
process.env.TZ = 'UTC';
const { default: factory } = await import('../clock-fw.mjs');

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });

const EVT = { BTN1: 0x91, BTN2: 0x92, REL: 0x93, S1: 0x94, S2: 0x95 };
const SEC = { CAL: 0, ASTRO: 1, DISP: 2, DIAG: 3, SYS: 4 };
const STORE_BYTES = 16384;
const BASE = ['MODE_ISO8601_STD = enabled'];

async function clock(store) {
  const M = await factory();
  const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
  const reg = w('emu_register_file', 'void', ['string', 'number', 'number']), fileMtime = w('emu_file_mtime', 'void', ['number', 'number']);
  const readConfig = w('emu_read_config'), removeFile = w('emu_file_remove', 'void', ['string']);
  const ev = w('emu_menu_event', 'void', ['number']), layer = w('emu_menu_layer', 'number'), secOf = w('emu_menu_section', 'number');
  const rowPtr = w('emu_daterow', 'number'), peekStore = w('emu_ee_peek', 'number', ['number']), pokeStore = w('emu_ee_poke', 'void', ['number', 'number']);
  const eeReset = w('emu_ee_reset'), eeLoad = w('emu_ee_load'), eeCommit = w('emu_ee_commit', 'number'), dirty = w('emu_menu_dirty', 'number');
  const row = () => { const p = rowPtr(); let s = ''; for (let i = 1; i <= 10; i++) { const c = M.HEAPU8[p + i]; if (c < 32 || c > 126) break; s += String.fromCharCode(c); } return s.trimEnd(); };
  w('emu_boot_cold', 'void', ['number'])(1783627200);
  eeReset();                                          // a blank SETTINGS.BIN...
  if (store) { for (let i = 0; i < STORE_BYTES; i++) pokeStore(i, store[i]); eeLoad(); }   // ...or the one carried over
  const back = () => { for (let i = 0; i < 6 && layer() !== 0; i++) { ev(EVT.S2); ev(EVT.REL); } };
  const c = {
    peek: w('emu_cfg_peek', 'number', ['string']),
    dirty,
    file: null,
    // A host save: new contents and a new modification time, then the clock's reload.
    save(lines, at) {
      const bytes = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
      const ptr = M._malloc(bytes.length); M.HEAPU8.set(bytes, ptr);
      reg('/CONFIG.TXT', ptr, bytes.length); fileMtime(at, at); readConfig();
      c.file = { lines, at };
    },
    remove() { removeFile('/CONFIG.TXT'); readConfig(); },
    goto(sec, label) {
      back(); ev(EVT.S1); ev(EVT.REL);
      for (let g = 0; secOf() !== sec && g < 8; g++) ev(EVT.BTN1);
      ev(EVT.S1); ev(EVT.REL);
      for (let h = 0; !row().startsWith(label) && h < 40; h++) ev(EVT.BTN1);
      return row().startsWith(label);
    },
    // EDIT, one tap, leave the editor (DONE for a toggle, APPLY for a value), back to the clock.
    menuTap(sec, label) { const ok = c.goto(sec, label); ev(EVT.S1); ev(EVT.REL); ev(EVT.BTN1); ev(EVT.S1); ev(EVT.REL); back(); return ok; },
    settle() { if (dirty()) eeCommit(); },             // the main loop saves a pending change within seconds
    // Power off and on again: everything in RAM goes, the store and the file stay.
    // newFile: the file was changed and the clock never looked at it before the power went.
    // dropFileRecords: the store as an older build left it, or as a write cut short leaves it.
    async powerCycle(newFile, { dropFileRecords = false } = {}) {
      const bytes = new Uint8Array(STORE_BYTES);
      for (let i = 0; i < STORE_BYTES; i++) bytes[i] = peekStore(i);
      if (dropFileRecords) for (let o = 0; o < 8192; o += 64)   // "MK4X" slots: spoil the CRC
        if (bytes[o] === 0x58 && bytes[o + 1] === 0x34 && bytes[o + 2] === 0x4B && bytes[o + 3] === 0x4D) bytes[o + 62] ^= 0xFF;
      const n = await clock(bytes);
      const f = newFile ?? c.file;
      if (f) n.save(f.lines, f.at);
      return n;
    },
  };
  return c;
}
// After a scenario: a power cycle (with the pending save done first) changes none of these settings.
async function stable(name, c, keys) {
  c.settle();
  const n = await c.powerCycle();
  const diff = keys.filter((k) => n.peek(k) !== c.peek(k)).map((k) => `${k} ${c.peek(k)}->${n.peek(k)}`);
  check(`${name}: a power cycle changes nothing${diff.length ? ` (${diff.join(', ')})` : ''}`, diff.length === 0);
  return n;
}

// ---- A value: DISP > PAGE (page_ms) ---------------------------------------------------------------
{
  let c = await clock();
  c.save([...BASE, 'page_ms = 2000'], 10);
  check('PAGE: the file sets 2000', c.peek('page_ms') === 2000);
  check('PAGE: the row is found', c.menuTap(SEC.DISP, 'PAGE'));
  const menuVal = c.peek('page_ms');
  check(`PAGE: the menu changes it (to ${menuVal})`, menuVal !== 2000);
  c.settle();

  c.save([...BASE, 'page_ms = 2000', 'nmea = rmc'], 11);
  check(`PAGE: another line changes, the menu's value stays (${c.peek('page_ms')})`, c.peek('page_ms') === menuVal && c.peek('nmea') === 1);
  check('PAGE: that merge is queued for saving, so the store knows the new file', c.dirty() === 1);
  c.save([...BASE, 'page_ms = 2000', 'nmea = rmc'], 12);
  check('PAGE: the same file saved again, the menu\'s value stays', c.peek('page_ms') === menuVal);
  c = await stable('PAGE, menu value standing', c, ['page_ms', 'nmea']);
  check('PAGE: and the value after it is the menu\'s', c.peek('page_ms') === menuVal);

  c.save([...BASE, 'page_ms = 3000', 'nmea = rmc'], 13);
  check(`PAGE: its own line changes, the file wins (${c.peek('page_ms')})`, c.peek('page_ms') === 3000);
  c.save([...BASE, 'nmea = rmc'], 14);
  check(`PAGE: the line is then removed: the default, the menu's old value does not come back (${c.peek('page_ms')})`, c.peek('page_ms') === 0);
  c = await stable('PAGE, after the file won', c, ['page_ms']);
  check('PAGE: still the default after it', c.peek('page_ms') === 0);
}

// A line removed while the menu's choice stands: the file stops having an opinion, the menu keeps it.
{
  let c = await clock();
  c.save([...BASE, 'page_ms = 2000'], 10);
  c.menuTap(SEC.DISP, 'PAGE'); const menuVal = c.peek('page_ms'); c.settle();
  c.save(BASE, 11);
  check(`removed line: the menu's value stays (${c.peek('page_ms')})`, c.peek('page_ms') === menuVal);
  c = await stable('removed line', c, ['page_ms']);
  c.save([...BASE, 'page_ms = 4000'], 12);
  check('removed line: put back with a value, the file wins', c.peek('page_ms') === 4000);
  c.save(BASE, 13);
  check('removed line: removed again, the default', c.peek('page_ms') === 0);
}

// The file is briefly absent (an editor that saves by delete and rename), then back unchanged.
{
  const c = await clock();
  c.save([...BASE, 'page_ms = 2000'], 10);
  c.menuTap(SEC.DISP, 'PAGE'); const menuVal = c.peek('page_ms'); c.settle();
  c.remove();
  check('file absent: the menu\'s value applies', c.peek('page_ms') === menuVal);
  c.save([...BASE, 'page_ms = 2000'], 11);
  check(`file back unchanged: the menu's value still applies (${c.peek('page_ms')})`, c.peek('page_ms') === menuVal);
  await stable('file absent then back', c, ['page_ms']);
}

// ---- A setting the file did not mention when the menu set it: DIAG > F HOLD -----------------------
// freq_hold is on by default, so the menu's choice is OFF, to be told apart from the default.
{
  let c = await clock();
  c.save(BASE, 10);
  check('F HOLD: the row is found', c.menuTap(SEC.DIAG, 'F HOLD'));
  check('F HOLD: the menu switches it off', c.peek('freq_hold') === 0);
  c.settle();
  c.save([...BASE, 'nmea = rmc'], 11);
  check('F HOLD: another line is added, it stays off', c.peek('freq_hold') === 0);
  c.save([...BASE, 'nmea = rmc', 'freq_hold = on'], 12);
  check('F HOLD: its own line is added, the file wins', c.peek('freq_hold') === 1);
  c.save([...BASE, 'nmea = rmc'], 13);
  check('F HOLD: the line is removed again: on, its default; the menu\'s choice does not come back', c.peek('freq_hold') === 1);
  c = await stable('F HOLD', c, ['freq_hold']);
}

// ---- A mode row: CAL > UNIX -----------------------------------------------------------------------
{
  let c = await clock();
  c.save([...BASE, 'MODE_UNIX = enabled'], 10);
  check('UNIX: the row is found', c.menuTap(SEC.CAL, 'UNIX'));
  check('UNIX: the menu switches the mode off', c.peek('MODE:MODE_UNIX') === 0);
  c.settle();
  c.save([...BASE, 'MODE_UNIX = enabled', 'MODE_MOON = enabled'], 11);
  check('UNIX: another mode is added to the file, UNIX stays off', c.peek('MODE:MODE_UNIX') === 0 && c.peek('MODE:MODE_MOON') === 1);
  c = await stable('UNIX, menu choice standing', c, ['MODE:MODE_UNIX', 'MODE:MODE_MOON']);
  c.save([...BASE, 'MODE_UNIX = disabled', 'MODE_MOON = enabled'], 12);
  c.save([...BASE, 'MODE_UNIX = enabled', 'MODE_MOON = enabled'], 13);
  check('UNIX: its line is changed and changed back: the file wins, the mode is on', c.peek('MODE:MODE_UNIX') === 1);
  await stable('UNIX, after the file won', c, ['MODE:MODE_UNIX']);
}

// ---- A setting made of several lines: DIAG > TEMPCOMP (tc_learn, tc_apply, tc_persist) -------------
{
  let c = await clock();
  c.save([...BASE, 'tc_learn = off'], 10);
  check('TEMPCOMP: the row is found', c.menuTap(SEC.DIAG, 'TEMPCO'));
  // The file's "tc_learn = off" leaves the compensator incomplete (the other two are on by default), so
  // the row reads OFF and one tap arms all three.
  const armed = () => `${c.peek('tc_learn')}${c.peek('tc_apply')}${c.peek('tc_persist')}`;
  check(`TEMPCOMP: the menu arms all three (${armed()})`, armed() === '111');
  c.settle();
  c.save([...BASE, 'tc_learn = off', 'nmea = rmc'], 11);
  check(`TEMPCOMP: another line changes, all three stay (${armed()})`, armed() === '111');
  c.save([...BASE, 'tc_learn = off', 'nmea = rmc', 'tc_persist = on'], 12);
  check(`TEMPCOMP: one of its lines is added: the file wins, and the one the file leaves alone goes back to its default (${armed()})`, armed() === '011');
  await stable('TEMPCOMP, after the file won', c, ['tc_learn', 'tc_apply', 'tc_persist']);
}

// ---- Edited on a computer and unplugged before the clock looked at the file again -----------------
{
  const c = await clock();
  c.save([...BASE, 'page_ms = 2000', 'freq_hold = off'], 10);
  c.menuTap(SEC.DISP, 'PAGE'); const menuVal = c.peek('page_ms');
  c.menuTap(SEC.DIAG, 'F HOLD');                       // the file says off, the menu says on
  c.settle();
  const n = await c.powerCycle({ lines: [...BASE, 'page_ms = 2000', 'freq_hold = off', 'nmea = rmc'], at: 11 });
  check(`unseen edit of another line: both menu choices stand at power-on (${n.peek('page_ms')}, ${n.peek('freq_hold')})`, n.peek('page_ms') === menuVal && n.peek('freq_hold') === 1 && n.peek('nmea') === 1);
  n.settle();
  const m = await n.powerCycle({ lines: [...BASE, 'page_ms = 3000', 'freq_hold = off', 'nmea = rmc'], at: 12 });
  check(`unseen edit of one setting's line: the file wins that one (${m.peek('page_ms')}), the other choice stands (${m.peek('freq_hold')})`, m.peek('page_ms') === 3000 && m.peek('freq_hold') === 1);
  await stable('unseen edits', m, ['page_ms', 'freq_hold', 'nmea']);
}

// ---- A store with no file record: an older build's, or a write cut short. The stamp decides. --------
{
  const c = await clock();
  c.save([...BASE, 'page_ms = 2000'], 10);
  c.menuTap(SEC.DISP, 'PAGE'); const menuVal = c.peek('page_ms');
  c.menuTap(SEC.DIAG, 'F HOLD');                       // on by default: the menu's choice is off
  c.settle();
  const same = await c.powerCycle(undefined, { dropFileRecords: true });
  check(`no file record, the file unchanged: the menu's choices stand (${same.peek('page_ms')}, ${same.peek('freq_hold')})`, same.peek('page_ms') === menuVal && same.peek('freq_hold') === 0);
  const n = await c.powerCycle({ lines: [...BASE, 'page_ms = 2000', 'nmea = rmc'], at: 11 }, { dropFileRecords: true });
  check(`no file record, the file changed: a setting it mentions goes to the file (${n.peek('page_ms')}, the menu had ${menuVal})`, n.peek('page_ms') === 2000);
  check('no file record, the file changed: a setting it does not mention keeps the menu\'s choice', n.peek('freq_hold') === 0);
  check('and the store is queued to be written again, with its file record', n.dirty() === 1);
  n.menuTap(SEC.DISP, 'PAGE'); const again = n.peek('page_ms'); n.settle();
  const p = await n.powerCycle({ lines: [...BASE, 'page_ms = 2000', 'nmea = all'], at: 12 });
  check(`after that the comparison is exact again (${p.peek('page_ms')})`, p.peek('page_ms') === again && p.peek('freq_hold') === 0);
}

// ---- Many saves: the two records of a pair cross from one page of the store to the other ------------
{
  let c = await clock();
  c.save([...BASE, 'page_ms = 2000'], 10);
  c.menuTap(SEC.DISP, 'PAGE'); const menuVal = c.peek('page_ms'); c.settle();
  let ok = true;
  for (let i = 0; i < 75; i++) {                       // a page holds 32 pairs
    c.menuTap(SEC.DIAG, 'F HOLD'); c.settle();
    if (i % 9 === 8) {                                 // power cycles along the way, the file touched each time
      const want = c.peek('freq_hold');
      c = await c.powerCycle({ lines: [...BASE, 'page_ms = 2000', `text = T${i}`], at: 20 + i });
      if (c.peek('freq_hold') !== want || c.peek('page_ms') !== menuVal) ok = false;
      c.settle();
    }
  }
  check('75 saves and 8 power cycles: every choice is still there, the file record with it', ok);
}

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
