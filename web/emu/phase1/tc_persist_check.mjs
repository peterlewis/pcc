// tc_persist_check.mjs — the tempcomp retained-model store (ee2), exercised against the firmware's OWN
// ee2_load / ee2_commit / tc_seed_from_flash / tc_seed_apply / tc_persist_after_seed (flash shimmed to a
// RAM buffer, ee2_emu[]). This is the auto-persist path: while GPS-locked the clock LEARNS its oscillator
// tempco; with tc_persist = on that model is saved to a dedicated 2-page flash store and, on the next
// power-up, loaded back as an evolving seed so the very first holdover is already compensated.
//
// Covers: commit a well-supported model -> "power cycle" (clear the RAM model, keep flash) -> the boot
// seed sequence restores it as the live model; config.txt precedence (tc_seed = off wins); load-sanity
// rejection of an implausible model; power-loss CRC fallback (torn newest record -> prior generation);
// tc_forget erase; and the persist-worthiness gate (samples / coverage / residual).
// Run: node tc_persist_check.mjs   (from phase1/, after build.sh)
import factory from '../clock-fw.mjs';

const M = await factory();
const w = (n, r = 'void', a = []) => M.cwrap(n, r, a);
const bootCold   = w('emu_boot_cold', 'void', ['number']);
const ee2Reset   = w('emu_ee2_reset', 'void');
const ee2Load    = w('emu_ee2_load', 'void');
const ee2Commit  = w('emu_ee2_commit', 'number');
const ee2Peek    = w('emu_ee2_peek', 'number', ['number']);
const ee2Poke    = w('emu_ee2_poke', 'void', ['number', 'number']);
const persistSet = w('emu_tc_persist_set', 'void', ['number']);
const seedFlag   = w('emu_tc_seed_flag', 'void', ['number']);
const cfgTcDef   = w('emu_cfg_tc_defined', 'void', ['number']);
const forget     = w('emu_tc_forget', 'void');
const supported  = w('emu_tc_model_supported', 'number');
const setModel   = w('emu_tc_set_model', 'void', ['number', 'number', 'number', 'number', 'number', 'number']);
const clearModel = w('emu_tc_clear_model', 'void');
const seedBoot   = w('emu_tc_seed_boot', 'void');
const tc2Probe   = w('emu_tc2_probe', 'number', ['number']);   // loaded flash shadow (tc2)
const tcProbe    = w('emu_tc_probe', 'number', ['number']);    // live applied model

const T2 = { valid: 0, hse_valid: 1, lse_valid: 2, hse_b: 3, hse_c: 4, lo: 5, hi: 6, n_hse: 7, t0: 8 };
const LP = { hse_valid: 0, hse_b: 2, hse_c: 3 };               // emu_tc_probe field ids
const CFG = { SEED: 1, T0: 2, LO: 4, HI: 8 };                  // cfg_tc_defined bits (mirror main.c)
const EE_REC = 64;

const results = [];
const approx = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const check = (n, pass) => results.push({ n, pass: !!pass });

bootCold(1783627200);

// A believable learned HSE model: slope 0.12 ppm/°C, curvature -0.004 ppm/°C², coverage 18..44 °C,
// 500 samples, residual 1.2 ppm — comfortably past the persist-worthiness gate.
const B = 0.12, C = -0.004, LO = 18, HI = 44, N = 500, RES = 1.2;

// (1) commit -> power cycle -> the boot seed restores the model as the live compensator.
ee2Reset(); cfgTcDef(0); persistSet(1);
setModel(B, C, LO, HI, N, RES);
check(`well-supported model commits`, ee2Commit() === 1);
check(`flash shadow hse_b ~ ${B}`, approx(tc2Probe(T2.hse_b), B));
check(`flash shadow hse_c ~ ${C}`, approx(tc2Probe(T2.hse_c), C));
check(`flash shadow coverage ${LO}..${HI}`, tc2Probe(T2.lo) === LO && tc2Probe(T2.hi) === HI);
check(`flash shadow n_hse ${N}`, tc2Probe(T2.n_hse) === N);

clearModel(); persistSet(1);        // "power cycle": RAM model gone, config.txt still says tc_persist = on
ee2Load();                          // boot re-scan of the flash store
check(`re-scan finds a valid shadow`, tc2Probe(T2.valid) === 1);
seedBoot();                         // the readConfigFile seed sequence (from_flash -> apply -> after_seed)
check(`boot seed makes the live model valid`, tcProbe(LP.hse_valid) === 1);
check(`seeded live hse_b ~ ${B}`, approx(tcProbe(LP.hse_b), B));
check(`seeded live hse_c ~ ${C}`, approx(tcProbe(LP.hse_c), C));

// (2) precedence — config.txt sets tc_seed = off (and defines the key) -> the flash seed stands down.
ee2Reset(); cfgTcDef(0); persistSet(1); setModel(B, C, LO, HI, N, RES); ee2Commit();
clearModel(); persistSet(1);
cfgTcDef(CFG.SEED); seedFlag(0);    // config.txt: tc_seed = off, explicitly defined
ee2Load(); seedBoot();
check(`tc_seed=off in config -> flash seed ignored`, tcProbe(LP.hse_valid) === 0);

// (3) load-sanity — an implausible coefficient (write side has no magnitude bound) is rejected on load.
ee2Reset(); cfgTcDef(0); persistSet(1);
setModel(50.0, 0.0, LO, HI, N, RES);   // hse_b = 50 ppm/°C, far past the |b| < 10 sanity bound
check(`implausible model still commits (CRC-valid record)`, ee2Commit() === 1);
clearModel(); persistSet(1);
ee2Load();
check(`shadow loads (record CRC is valid)`, tc2Probe(T2.valid) === 1);
seedBoot();
check(`implausible model rejected by load-sanity -> not seeded`, tcProbe(LP.hse_valid) === 0);

// (4) power-loss — two generations, corrupt the newer record's CRC -> reload falls back to the older.
ee2Reset(); cfgTcDef(0); persistSet(1);
setModel(0.10, 0, LO, HI, N, RES); ee2Commit();   // gen1 (slot 0): hse_b 0.10
setModel(0.20, 0, LO, HI, N, RES); ee2Commit();   // gen2 (slot 1): hse_b 0.20
ee2Poke(EE_REC + 62, ee2Peek(EE_REC + 62) ^ 0xFF); // flip a bit in slot-1's CRC16 (offset 62)
clearModel(); persistSet(1); ee2Load();
check(`torn gen2 rejected -> falls back to gen1 (${tc2Probe(T2.hse_b).toFixed(3)})`, approx(tc2Probe(T2.hse_b), 0.10));

// (5) tc_forget ("tc_forget = on" over serial) erases the store; a reboot re-scan finds nothing.
ee2Reset(); cfgTcDef(0); persistSet(1); setModel(B, C, LO, HI, N, RES); ee2Commit();
check(`pre-forget: a model is stored`, tc2Probe(T2.valid) === 1);
forget();
check(`tc_forget clears the shadow`, tc2Probe(T2.valid) === 0);
clearModel(); ee2Load();
check(`tc_forget erased flash (reboot finds nothing)`, tc2Probe(T2.valid) === 0);

// (6) persist-worthiness gate — a shaky fit must never reach flash (so it can't auto-seed a bad steer).
setModel(B, C, LO, HI, 50, RES);   // 50 samples < 300
check(`few-sample model not persist-worthy`, supported() === 0);
setModel(B, C, LO, HI, N, RES);
check(`well-sampled model persist-worthy`, supported() === 1);
setModel(B, C, 20, 22, N, RES);    // 2 °C coverage < 4
check(`narrow-coverage model not persist-worthy`, supported() === 0);

let fail = 0;
for (const r of results) { if (!r.pass) fail++; console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}`); }
console.log(fail ? `\n${fail} FAIL` : `\nALL PASS`);
process.exit(fail ? 1 : 0);
