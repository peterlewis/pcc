// Golden-trace conformance runner: drives the WASM emulator across a scenario battery and
// checks its decoded display against independent ground truth (truth.mjs). Reports divergences.
import { loadEmu, snapshot, tickN, pps } from './harness.mjs';
import * as T from './truth.mjs';

const anchors = T.selfTest();
if (anchors.length){ console.error('GROUND-TRUTH ANCHORS FAILED — aborting:\n'+anchors.join('\n')); process.exit(2); }

const emu = await loadEmu();
const results = { pass:0, fail:0, cases:0, byKind:{}, fails:[] };
function record(kind, ok, detail){
  results.cases++; results.byKind[kind] ??= {pass:0,fail:0};
  if (ok){ results.pass++; results.byKind[kind].pass++; }
  else   { results.fail++; results.byKind[kind].fail++; if (results.fails.length<40) results.fails.push({kind,...detail}); }
}
const arrEq = (a,b) => a.length===b.length && a.every((x,i)=>x===b[i]);

// Boot LOCKED at `epoch`, advance one full second so the display latches, return snapshot.
// Comparison is always against truth(emu.now()) — whatever second actually latched.
function gotoLocked(epoch, mode=0){
  emu.boot(epoch>0?epoch-1:epoch);   // boot at E-1; the tick below rolls to E and latches
  emu.enable(mode);
  if (mode!==0){ /* cycle to the target mode */ for(let g=0;g<40 && emu.mode()!==mode;g++){ emu.button1(); if(emu.pendsvPending())emu.pendsv(); } }
  tickN(emu, 1000);                  // 1 s -> .900 stages next, rollover latches it
  return snapshot(emu);
}

// ---- CIVIL (ISO 8601): big digits + date row must match JS Date UTC exactly ---------------
function testCivil(epochs){
  for (const e of epochs){
    const s = gotoLocked(e, 0);
    const now = s.now;
    const want = T.civil(now);
    const okBig  = arrEq(s.big, want.big);
    const okDate = s.dateRow === want.dateRow;
    const okDp   = s.dp === true;                    // locked P3
    const okSmall = s.small.every(x => typeof x==='number' && x>=0 && x<=9);  // real digits, not blank/dash
    record('civil-time', okBig,  {now, got:s.bigStr, want:want.big.join('')});
    record('civil-date', okDate, {now, got:s.dateRow, want:want.dateRow});
    record('civil-dp',   okDp && okSmall, {now, dp:s.dp, small:s.smallStr});
    record('civil-colon', s.colon===emu.colonCivil(), {now, colon:s.colon, wantCivil:emu.colonCivil()});
  }
}

// diverse civil epochs — WITHIN the firmware's representable domain (RTC year 00-99 => 2000-2099).
// Pre-2000/negative epochs are out of domain (the real hardware can't show them either).
const civilEpochs = [];
{
  const push = (y,mo,d,h,mi,s)=>civilEpochs.push(Math.floor(Date.UTC(y,mo,d,h,mi,s)/1000));
  push(2026,6,5,13,50,34);                 // the demo instant
  push(2000,0,1,0,0,0);                    // domain start
  push(2000,1,29,12,0,0);                  // leap day 2000 (÷400)
  push(2024,1,29,23,59,59);                // leap day 2024 -> Mar 1
  push(2023,1,28,23,59,59);                // non-leap Feb 28 -> Mar 1
  push(2096,1,29,12,0,0);                  // 2096 leap day (last ÷4 leap in domain)
  push(2099,11,31,23,59,58);               // domain end year rollover
  push(2038,0,19,3,14,7);                  // 32-bit time_t boundary (Y2038)
  for (let i=0;i<500;i++) civilEpochs.push(946684800 + Math.floor(i*6_300_000));  // 2000->2099 sweep
  for (let h=0;h<24;h++) push(2026,6,5,h,59,59);   // every hour rollover on one day
  for (let mi=0;mi<60;mi++) push(2044,2,1,12,mi,59); // every minute rollover in an hour
}
// RTC year field is 00-99 => the firmware only represents 2000-01-01 .. 2099-12-31.
const DOMAIN_LO = 946684800, DOMAIN_HI = 4102444799;
const inDomain = e => e>=DOMAIN_LO && e<=DOMAIN_HI;
testCivil(civilEpochs.filter(inDomain));

// ---- helpers for the ticking alt-time-row modes (LST / SOLAR) -----------------------------
const bigToSec = (big) => big.some(x=>typeof x!=='number') ? null
  : (big[0]*10+big[1])*3600 + (big[2]*10+big[3])*60 + (big[4]*10+big[5]);
const circDiff = (a,b) => { let d=((a-b)%86400+86400)%86400; return d>43200 ? d-86400 : d; };  // a-b in [-43200,43200]

// Boot locked at epoch, set position, cycle to an alt mode, settle the alt timebase, snapshot.
function gotoAlt(epoch, mode, lat, lon){
  emu.boot(epoch-1);
  emu.setPos(lat, lon);
  emu.enable(mode);
  for (let g=0; g<48 && emu.mode()!==mode; g++){ emu.button1(); if(emu.pendsvPending())emu.pendsv(); }
  for (let k=0;k<2;k++){ emu.poll(); tickN(emu,1000); }   // stage + latch across two boundaries
  emu.poll();
  return snapshot(emu);
}

// tick one civil second (staging the alt reading) and return the fresh snapshot.
function altStep1s(){ emu.poll(); tickN(emu,1000); emu.poll(); return snapshot(emu); }

// ---- SIDEREAL (LST): match independent IAU GMST; verify it TICKS; verify the alt colon --------
function testSidereal(cases){
  let maxDev = 0;
  for (const {epoch,lat,lon} of cases){
    const s = gotoAlt(epoch, emu.LST, lat, lon);
    const disp = bigToSec(s.big);
    if (disp===null){ record('sidereal', false, {now:s.now,lon,note:'blanked',big:s.bigStr}); continue; }
    const d = circDiff(disp, Math.floor(T.lstSeconds(s.now, lon)));
    maxDev = Math.max(maxDev, Math.abs(d));
    record('sidereal', Math.abs(d)<=1, {now:s.now,lon,got:s.bigStr,diff:d});
    // colon honesty: LST must NOT read as civil time
    record('sidereal-colon', s.colon===emu.colonAlt() && emu.colonAlt()!==emu.colonCivil(),
      {colon:s.colon, alt:emu.colonAlt(), civil:emu.colonCivil()});
    // liveness: sidereal must advance ~1 s (occasionally 2 at the double-step), never stale
    const s2 = altStep1s(); const disp2 = bigToSec(s2.big);
    const adv = disp2===null ? null : circDiff(disp2, disp);
    record('sidereal-live', adv!==null && adv>=1 && adv<=2, {now:s.now, adv});
  }
  return maxDev;
}

// ---- SOLAR: match independent mean-solar + USNO EoT; tight ±2 s; flag systematic bias --------
function testSolar(cases){
  let maxDev = 0; const signed = [];
  for (const {epoch,lat,lon} of cases){
    const s = gotoAlt(epoch, emu.SOL, lat, lon);
    const disp = bigToSec(s.big);
    if (disp===null){ record('solar', false, {now:s.now,lon,note:'blanked',big:s.bigStr}); continue; }
    const d = circDiff(disp, Math.floor(T.solarSeconds(s.now, lon)));
    maxDev = Math.max(maxDev, Math.abs(d)); signed.push(d);
    record('solar', Math.abs(d)<=2, {now:s.now,lon,got:s.bigStr,diff:d});
    // longitude scale: a 1° shift must move apparent solar time by ~240 s (shift toward the
    // interior so lon±1 stays within ±180 at the dateline/antimeridian sites).
    const dir = (lon+1 <= 180) ? 1 : -1;
    const sE = gotoAlt(epoch, emu.SOL, lat, lon+dir);
    const de = bigToSec(sE.big)!==null ? circDiff(bigToSec(sE.big), disp) : null;
    record('solar-lonscale', de!==null && Math.abs(de - dir*240)<=2, {lon, dir, movedBy:de, want:dir*240});
  }
  // systematic bias: the mean signed deviation should be ~0 (a constant offset = a real bug)
  const mean = signed.reduce((a,b)=>a+b,0)/(signed.length||1);
  record('solar-bias', Math.abs(mean) < 0.5, {meanSignedDev:+mean.toFixed(3), n:signed.length});
  return maxDev;
}

// ---- PRECISION LADDER (holdover honesty) — driven by T.precision(), incl. the asymmetric P1 ---
function testPrecision(){
  const base = Math.floor(Date.UTC(2040,5,15,10,30,0)/1000);
  // (pps_age, cal_age) pairs. Boundaries verify the firmware uses '<' (exclusive); the P1 rows
  // set pps OLD but rtc FRESH so the distinct rtc_last_calibration branch is genuinely exercised.
  const pairs = [
    [0,0],[500,500],[999,999],          // P3 (incl. just under t1)
    [1000,1000],[1500,1500],[9999,9999],// P2 (1000 => NOT P3, proving '<')
    [10000,5000],[20000,20000],[50000,99999],  // P1 — pps>=t10 but rtc<t100 (asymmetric path)
    [200000,200000],[10000,200000],     // P0 (fallthrough; and pps old + rtc old)
  ];
  for (const [pps,cal] of pairs){
    emu.boot(base); emu.enable(0); tickN(emu,1000);
    emu.forceHoldover2(pps, cal);
    tickN(emu, 300);                       // populate non-blanked slots (no second rollover)
    const s = snapshot(emu);
    const exp = T.precision({hadPps:true, sincePps:pps, calAge:cal});
    const okDash = s.small.map(x=>x==='-').every((v,i)=>v===exp.dashes[i]);
    record('precision', okDash && s.dp===exp.dpExpected, {pps,cal,level:exp.level,got:{small:s.smallStr,dp:s.dp},want:exp});
  }
  // cold boot (never had a fix) must be P0 with DP off — the honest no-lock state.
  emu.bootCold(base); emu.enable(0); tickN(emu,1000);
  const c = snapshot(emu);
  const cexp = T.precision({hadPps:false, sincePps:0});
  record('precision', c.small.every(x=>x==='-') && c.dp===false, {case:'coldboot',got:{small:c.smallStr,dp:c.dp},want:cexp});
}

// ---- ALT-MODE POSITION LOSS (honesty): no valid position => dashes, never GMST-as-LST ---------
function testAltNoPos(){
  const E = Math.floor(Date.UTC(2035,3,10,23,59,50)/1000);   // just before midnight
  emu.boot(E-1); emu.setPos(999,999);                        // out of range => astro_pos_ok fails
  emu.enable(emu.LST);
  for (let g=0;g<48 && emu.mode()!==emu.LST;g++){ emu.button1(); if(emu.pendsvPending())emu.pendsv(); }
  for (let k=0;k<2;k++){ emu.poll(); tickN(emu,1000); } emu.poll();
  const s1 = snapshot(emu);
  record('altnopos-dash', s1.big.every(x=>x==='-') && s1.dp===false, {got:s1.bigStr, dp:s1.dp});
  const date1 = s1.dateRow;
  for (let k=0;k<20;k++){ emu.poll(); tickN(emu,1000); }      // cross midnight while dashed
  const s2 = snapshot(emu);
  record('altnopos-datelive', s2.big.every(x=>x==='-') && s2.dateRow!==date1 && /^\d{4}-\d\d-\d\d$/.test(s2.dateRow),
    {before:date1, after:s2.dateRow, stillDashed:s2.big.every(x=>x==='-')});
}

// battery for the alt/precision dimensions
const altCases = [];
{
  const P = (name,lat,lon)=>({name,lat,lon});
  const sites = [ P('greenwich',51.4779,-0.0015), P('nyc',40.71,-74.0), P('tokyo',35.68,139.69),
                  P('sydney',-33.87,151.2), P('equator',0,0), P('dateline',0,179.9),
                  P('antimeridian',0,-179.9), P('reykjavik',64.1,-21.9) ];
  const times = [];
  const pushT=(y,mo,d,h,mi,s)=>times.push(Math.floor(Date.UTC(y,mo,d,h,mi,s)/1000));
  for (let i=0;i<40;i++) pushT(2024, (i*3)%12, 1+(i%27), (i*7)%24, (i*13)%60, (i*17)%60);
  pushT(2030,0,1,0,0,0); pushT(2050,5,21,12,0,0); pushT(2000,0,1,0,0,0);
  for (const site of sites) for (const t of times) if (inDomain(t)) altCases.push({epoch:t,lat:site.lat,lon:site.lon});
}
const sidDev = testSidereal(altCases);
const solDev = testSolar(altCases);
testPrecision();
testAltNoPos();

// ---- CALENDAR date-row modes (UNIX / ISO-ordinal / ISO-week / WEEKDAY) --------------------
// Payload on the date row; big digits keep civil time (validated separately). Exact match.
function testCalendar(epochs){
  const modes = [
    {idx:emu.M_UNIX,    key:'unix',    truth:T.unixRow},     // named ids, not magic numbers
    {idx:emu.M_ORDINAL, key:'ordinal', truth:T.ordinalRow},
    {idx:emu.M_ISOWEEK, key:'isoweek', truth:T.isoWeekRow},
    {idx:emu.M_WEEKDAY, key:'weekday', truth:T.weekdayRow},
    {idx:emu.M_JULIAN,  key:'julian',  truth:T.julianRow},   // sprintf("%10f", unix/86400 + 2440587.5)
    {idx:emu.M_MJD,     key:'mjd',     truth:T.mjdRow},      // sprintf("%10f", unix/86400 + 40587)
  ];
  for (const m of modes) for (const e of epochs){
    // MODE_UNIX prints the epoch with signed %ld: post-2038-01-19 the firmware shows a NEGATIVE
    // value (a real Y2038 firmware quirk the emu reproduces). Exact-match the meaningful range.
    if (m.key==='unix' && e >= 2147483648) continue;
    const s = gotoLocked(e, m.idx);
    const want = m.truth(s.now);
    record('cal-'+m.key, s.dateRow===want, {now:s.now, mode:m.idx, got:s.dateRow, want});
  }
}
testCalendar(civilEpochs.filter(inDomain).filter((_,i)=>i%8===0));   // ~75 epochs x 4 modes

// ---- GRID (Maidenhead locator): deterministic from position; exact match ------------------
function testGrid(){
  const sites = [[51.4779,-0.0015],[40.71,-74.0],[35.68,139.69],[-33.87,151.2],[0,0],
                 [64.1,-21.9],[-33.87,18.42],[19.43,-99.13],[55.75,37.62],[-54.8,-68.3]];
  const E = Math.floor(Date.UTC(2027,3,12,9,15,0)/1000);
  for (const [lat,lon] of sites){
    emu.boot(E-1); emu.setPos(lat,lon); emu.enable(emu.M_GRID);
    for (let g=0;g<48 && emu.mode()!==emu.M_GRID;g++){ emu.button1(); if(emu.pendsvPending())emu.pendsv(); }
    for (let k=0;k<3;k++){ emu.poll(); tickN(emu,1000); } emu.poll();
    const s = snapshot(emu);
    const want = T.gridRow(lat,lon);
    record('grid', s.dateRow===want, {lat,lon,got:s.dateRow,want});
  }
}
testGrid();

// ---- report -------------------------------------------------------------------------------
console.log(`\nGOLDEN-TRACE CONFORMANCE  —  ${results.cases} checks`);
for (const [k,v] of Object.entries(results.byKind))
  console.log(`  ${k.padEnd(14)} ${v.pass}/${v.pass+v.fail} ${v.fail?'✗ '+v.fail+' FAIL':'✓'}`);
console.log(`  TOTAL          ${results.pass}/${results.cases} ${results.fail?('✗ '+results.fail+' FAILURES'):'✓ ALL PASS'}`);
console.log(`  (max deviation vs independent astro truth — sidereal ${sidDev}s, solar ${solDev}s)`);
if (results.fails.length){
  console.log('\nfirst divergences:');
  for (const f of results.fails.slice(0,15)) console.log('  ', JSON.stringify(f));
}
process.exit(results.fail?1:0);
