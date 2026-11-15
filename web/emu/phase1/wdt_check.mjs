// wdt_check.mjs — the opt-in independent watchdog (watchdog = on).
// The emulator has no IWDG, so this checks everything around the hardware: that nothing starts
// unless asked, that the one refresh point keeps refreshing once armed (the hardware cannot be
// stopped, so a missed refresh is a reset), and the boot-loop guard: watchdog resets are counted in
// memory that survives a reset, three in a row stand the watchdog down for that boot, and a
// healthy run clears the count and re-arms. Run: node wdt_check.mjs
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold = w('emu_boot_cold', 'void', ['number']), cfg = w('emu_config_line', 'void', ['string']);
const powerOn = w('emu_wdt_power_on'), wdtBoot = w('emu_wdt_boot', 'void', ['number']), poll = w('emu_wdt_poll');
const tag = w('emu_wdt_tag', 'void', ['number']), advance = w('emu_wdt_advance', 'void', ['number']);
const get = w('emu_wdt_get', 'number', ['number']), dump = w('emu_wdt_dump_line', 'string');
const G = { armed: 0, stoodDown: 1, resets: 2, consecutive: 3, lastTag: 4, starts: 5, kicks: 6, cfg: 7 };
const g = (k) => get(G[k]);

const results = [];
const check = (n, pass) => results.push({ n, pass: !!pass });
const passes = (n) => { for (let i = 0; i < n; i++) poll(); };

// 1. Off by default: the IWDG is never started and never refreshed.
bootCold(1718971200); powerOn();
passes(50);
check('default: not armed, the IWDG is never started or refreshed', g('armed') === 0 && g('starts') === 0 && g('kicks') === 0);
check(`default: the report says OFF ("${dump().trim()}")`, /cfg=0 armed=0 .*resets=0 consecutive=0 last_tag=- -- OFF/.test(dump()));

// 2. watchdog = on arms on the next pass, once, and every pass refreshes.
cfg('watchdog = on');
check('watchdog = on: the key is taken, nothing starts until the main loop runs', g('cfg') === 1 && g('starts') === 0);
poll();
check('first pass: started once and refreshed', g('armed') === 1 && g('starts') === 1 && g('kicks') === 1);
passes(100);
check('100 more passes: 100 more refreshes, no second start', g('starts') === 1 && g('kicks') === 101);
check('armed: the report says ARMED with the 8 s timeout', /cfg=1 armed=1 timeout=8000ms .* -- ARMED\r\n$/.test(dump()));

// 3. It cannot be stopped: turning the key off must NOT stop the refresh.
cfg('watchdog = off');
passes(10);
check('watchdog = off while armed: still refreshed on every pass', g('armed') === 1 && g('kicks') === 111);
check('... and the report says off takes effect at the next reset', /armed=1 .*takes effect at the next reset/.test(dump()));
cfg('watchdog = on');

// 4. A watchdog reset is counted, and the section that was running is kept.
tag(3); wdtBoot(1);
check('watchdog reset: counted, section 3 remembered, not armed until the loop runs',
  g('resets') === 1 && g('consecutive') === 1 && g('lastTag') === 3 && g('armed') === 0 && g('stoodDown') === 0);
poll();
check('... and the next boot arms again', g('armed') === 1 && g('starts') === 2);
check('... the report carries the count and the section', /resets=1 consecutive=1 last_tag=3 -- ARMED/.test(dump()));

// 5. Three in a row stand it down for that boot; a healthy minute re-arms it.
tag(6); wdtBoot(1); poll();
check('second reset in a row: still armed', g('consecutive') === 2 && g('armed') === 1);
tag(6); wdtBoot(1); passes(20);
check('third reset in a row: stood down, the IWDG is NOT started this boot', g('consecutive') === 3 && g('stoodDown') === 1 && g('armed') === 0 && g('starts') === 3);
check('stood down: the report says so', /resets=3 consecutive=3 last_tag=6 -- STOOD DOWN/.test(dump()));
advance(59000); passes(5);
check('59 s of running: still stood down', g('stoodDown') === 1 && g('armed') === 0);
advance(1000); poll();
check('60 s of running: the run is cleared and the watchdog re-arms', g('consecutive') === 0 && g('stoodDown') === 0 && g('armed') === 1 && g('starts') === 4);
check('the lifetime count and the last section survive the clear', g('resets') === 3 && g('lastTag') === 6);

// 6. A healthy run between two resets means they are not "in a row".
wdtBoot(1); poll(); advance(60000); poll();
check('reset, then a healthy minute: the run is back to 0', g('consecutive') === 0 && g('resets') === 4);
wdtBoot(1); poll();
check('the next reset starts a new run of 1 and stays armed', g('consecutive') === 1 && g('armed') === 1);

// 7. Any other reset (reboot chord, firmware update) is a fresh start for the run.
wdtBoot(1);
check('two in a row', g('consecutive') === 2);
wdtBoot(0); poll();
check('a non-watchdog reset clears the run, keeps the lifetime count, and arms', g('consecutive') === 0 && g('resets') === 6 && g('armed') === 1);

// 8. A power cycle forgets everything (RAM2 holds noise).
powerOn();
check('power-on: counts are zero, no section, key back to its default', g('resets') === 0 && g('consecutive') === 0 && g('lastTag') === 0xFF && g('cfg') === 0 && g('armed') === 0);

// 9. The report always fits the 192-byte CDC transmit buffer.
cfg('watchdog = on');
let longest = 0;
for (let i = 0; i < 3; i++) { tag(15); wdtBoot(1); }
longest = Math.max(longest, dump().length);
check(`the longest report fits the transmit buffer (${longest} bytes)`, longest > 0 && longest <= 192);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
