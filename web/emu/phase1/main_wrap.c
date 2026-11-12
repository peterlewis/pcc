#include "main.h"
#include "fatfs.h"
#include "usb_device.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "qspi_drv.h"
#include "zonedetect.h"
#include "chainloader.h"
/* Feature guards: the emulator also builds against LEANER clock4 branches (e.g. the tempcomp PR
 * branch) for conformance testing. astro is detected by its header; the sidereal alt_* staging has
 * no header of its own, so build.sh probes the firmware source and defines EMU_HAS_ALT. */
#if __has_include("astro.h")
#  include "astro.h"
#  define EMU_HAS_ASTRO 1
#else
#  define EMU_HAS_ASTRO 0
#endif
#ifndef EMU_HAS_CUCKOO
#  define EMU_HAS_CUCKOO 0
#endif
#ifndef EMU_HAS_TEMPCOMP
#  define EMU_HAS_TEMPCOMP 0
#endif
#ifndef EMU_HAS_TC_PERSIST
#  define EMU_HAS_TC_PERSIST 0
#endif
#ifndef EMU_HAS_ALT
#  define EMU_HAS_ALT 1
#endif
#ifndef EMU_HAS_ADEV
#  define EMU_HAS_ADEV 0
#endif
#ifndef EMU_HAS_STAR
#  define EMU_HAS_STAR 0
#endif
#ifndef EMU_HAS_FW_PERSIST
#  define EMU_HAS_FW_PERSIST 0
#endif
#ifndef EMU_HAS_FADE_WANDER
#  define EMU_HAS_FADE_WANDER 0
#endif
#ifndef EMU_HAS_CFG_REDERIVE
#  define EMU_HAS_CFG_REDERIVE 0
#endif
#ifndef EMU_HAS_FREQ_HOLD
#  define EMU_HAS_FREQ_HOLD 0
#endif
#ifndef EMU_HAS_WDT
#  define EMU_HAS_WDT 0
#endif
#ifndef EMU_HAS_EE_RDFAULT
#  define EMU_HAS_EE_RDFAULT 0
#endif
#ifndef EMU_HAS_BRIT
#  define EMU_HAS_BRIT 0
#endif
#include "shim_redirect.h"

#ifdef EMU_NATIVE64
/* Host (64-bit) twin: the firmware's __VECTORS_RAM is uint32_t[], but a native function pointer
 * is 64-bit — SetSysTick/SetPPS's (uint32_t)x cast would truncate it and dispatch would jump to
 * garbage. Redirect the two handler slots the emulator actually dispatches to a 64-bit side
 * table. (WASM keeps the real vector table: there function pointers ARE 32-bit table indices.) */
static void (*g_systick)(void) = 0;
static void (*g_pps)(void) = 0;
#undef SetSysTick
#undef SetPPS
#define SetSysTick(x) (g_systick = (void(*)(void))(x))
#define SetPPS(x)     (g_pps     = (void(*)(void))(x))
#endif

#define main fw_main_unused
#include "main.c"
#undef main

/* ================= emulator API (full in-TU access to main.c internals) ================= */
/* --- display readout (the firmware's actual latched output) --- */
unsigned char* emu_daterow(void){ return &uart2_tx_buffer[0]; }   /* [1..10] ASCII date row */
/* Render an arbitrary display mode's date row through the REAL sendDate(), for tests. Clears the
 * latch guard so the paint always happens; the row bytes land in uart2_tx_buffer[1..i]. */
void emu_render_mode(int m){ waitingForLatch = 0; displayMode = (uint8_t)m; sendDate(1); }
unsigned char  emu_seg_c(void){ return next7seg.c; }
unsigned short emu_seg_b(int i){ return next7seg.b[i]; }
unsigned short emu_bufb(int i){ return buffer_b[i]; }
unsigned char  emu_bufc_low(int i){ return buffer_c[i].low; }
unsigned char  emu_bufc_high(int i){ return buffer_c[i].high; }
/* Holdover-fade per-digit intensity, normalised 0..255 (255 = fully significant / lit). The real
 * display fades a digit by PWM dwell, which the latched-segment read can't see — so the emulator
 * reads this explicit channel instead. digit_bright[] = [deciseconds, centiseconds, ms, dp]. */
#if EMU_HAS_TEMPCOMP
unsigned char  emu_digit_fade(int i){ return (i>=0 && i<4) ? (unsigned char)((unsigned)digit_bright[i]*255u/FADE_MAX) : 255; }
#else
unsigned char  emu_digit_fade(int i){ (void)i; return 255; }   /* lean branch: no significance fade */
#endif
/* The firmware's live 3σ time-interval-error bound U(τ) in µs — the honest ± uncertainty that drives
 * the fade. Read it so the precision panel shows the SAME quantity the digits fade by, not the (now
 * overridden) dash-tolerance ladder. */
#if EMU_HAS_TEMPCOMP
double emu_holdover_u_us(void){ return (double)holdover_u_us; }
#else
double emu_holdover_u_us(void){ return 0; }
#endif
/* Live Allan-deviation engine (MODE_ADEV) — inject a phase series directly and read back the
 * overlapping ADEV, so a JS golden test can feed white/random-walk FM noise and assert the slopes
 * (tau^-1/2, tau^+1/2) AND cross-check every tau against a double-precision reference. */
#if EMU_HAS_ADEV
void   emu_adev_reset(void){ adev_reset(); }
void   emu_adev_push(double x_ticks){ adev_push_x((int32_t)lround(x_ticks)); }  /* bypass the DWT delta */
void   emu_adev_push_dwt(double dwt, double epoch){ adev_push_dwt((uint32_t)dwt, (uint32_t)epoch); }  /* the REAL capture path: wrap/gap/missed-second semantics */
int    emu_adev_valid(void){ return (int)adev_valid; }
void   emu_adev_reduce(void){ adev_reduce(); }
double emu_adev_sigma(int m){ return (m > 0) ? (double)adev_sigma_for_m((uint32_t)m) : 0.0; }
int    emu_adev_noctave(void){ return (int)adev_noct; }
#else
void   emu_adev_reset(void){}
void   emu_adev_push(double x){ (void)x; }
void   emu_adev_push_dwt(double dwt, double epoch){ (void)dwt; (void)epoch; }
int    emu_adev_valid(void){ return 0; }
void   emu_adev_reduce(void){}
double emu_adev_sigma(int m){ (void)m; return 0.0; }
int    emu_adev_noctave(void){ return 0; }
#endif
/* Tempcomp model read-back — for the companion app's temp-comp panel and warm-start verification.
 * field: 0 hse_valid · 1 lse_valid · 2 hse_b (ppm/°C) · 3 hse_c (ppm/°C²) · 4 lse_a (ppm)
 *        5 prior (model order still held from a seed; 0 = real-data-owned) · 6 state char (A/F/S/L/-)
 *        7 hse_resid (ppm) · 8 tc_t0 (°C) · 9 hse_tmin · 10 hse_tmax */
#if EMU_HAS_TEMPCOMP
double emu_tc_probe(int field){
  float tpp = (float)tc_tpp();
  switch (field){
    case 0:  return tc_hse_valid;
    case 1:  return tc_lse_valid;
    case 2:  return tc_hse_valid ? tc_hse_m[1] / tpp : 0;
    case 3:  return tc_hse_valid ? tc_hse_m[2] / tpp : 0;
    case 4:  return tc_lse_valid ? tc_lse_m[0] : 0;
    case 5:  return tc_hse_prior > tc_lse_prior ? tc_hse_prior : tc_lse_prior;
    case 6:  return (double)(unsigned char)tc_disp_state;
    case 7:  return tc_hse_valid ? tc_hse_resid / tpp : 0;
    case 8:  return tc_t0;
    case 9:  return tc_hse_tmin;
    case 10: return tc_hse_tmax;
    default: return 0;
  }
}
#else
double emu_tc_probe(int field){ (void)field; return 0; }
#endif
unsigned int   emu_now(void){ return (unsigned int)currentTime; }

static int emu_disp_on = 1;   /* display power model: see HAL_TIM_PWM_Start/Stop below */
/* --- boot a GPS-locked civil clock + 1 kHz tick dispatched through the real vector table --- */
void emu_boot(unsigned int t){
  huart2.Instance = USART2;   /* sendLatch() writes huart2.Instance->TDR (the date-board latch); MX
                               * init is stubbed so Instance is NULL -> point it at the shimmed USART2
                               * RAM struct. Meaningless in the emu (no date board), but stops the
                               * native twin faulting on a NULL->TDR (offset 0x28) store. */
  currentTime = (time_t)t; last_pps_time = (uint32_t)t; had_pps = 1;
  displayMode = MODE_ISO8601_STD; countMode = COUNT_NORMAL;
  config.tolerance_1ms = 1000; config.tolerance_10ms = 10000; config.tolerance_100ms = 100000;
  config.brightness_override = -1.0f;   /* AUTO: readConfigFile's reset, before any config line */
  config.modes_enabled[MODE_ISO8601_STD] = 1;
  emu_disp_on = 1;                      /* main() ends its init with displayOn() */
  setNextTimestamp(currentTime);
  setPrecision();
}
/* --- Colon DMA model --------------------------------------------------------------------
 * On hardware the colon PWM tables (buffer_colons_L/R[200], 10 ms/step, 2 s cycle) are cycled
 * into TIM2->CCR1/CCR2 by a FREE-RUNNING DMA; colonAnimationSync() (= HAL_DMA_Abort +
 * HAL_DMA_Start on TIM5 CH1/CH2) restarts it from index 0 at a PPS whose currentTime is even.
 * currentTime's parity is NOT stable inside a second — the .900 prep pre-increments it and the
 * RMC decode rewrites it at ~.300 — so reconstructing the index from live parity (the old
 * emu_colon_step) played the table in chopped, reordered segments. Model the DMA itself: a ms
 * counter that free-runs with SysTick and zeroes exactly where the firmware restarts the real
 * DMA. Defining HAL_DMA_Start/Abort natively here overrides the no-op --js-library stubs (a
 * native definition always wins over a JS-library fallback), so every firmware call site —
 * even-second PPS sync, future ones — hooks the model with no emulator-side guessing. */
static uint32_t colon_dma_ms;   /* ms since the colon DMA last (re)started */
HAL_StatusTypeDef HAL_DMA_Start(DMA_HandleTypeDef *hdma, uint32_t src, uint32_t dst, uint32_t len){
  (void)src; (void)dst; (void)len;
  if (hdma == &hdma_tim5_ch1) colon_dma_ms = 0;   /* colonAnimationStart(): table index 0 */
  return HAL_OK;
}
HAL_StatusTypeDef HAL_DMA_Abort(DMA_HandleTypeDef *hdma){ (void)hdma; return HAL_OK; }
/* Display power model. displayOff() stops the colon PWM (TIM2) and displayOn() restarts it; nothing
 * else in the emulator records which ran last, so a clock left dark by a missed displayOn() looked
 * exactly like a lit one. Track it the same way as the colon DMA above (native wins over the stub). */
HAL_StatusTypeDef HAL_TIM_PWM_Start(TIM_HandleTypeDef *htim, uint32_t ch){ (void)ch; if (htim == &htim2) emu_disp_on = 1; return HAL_OK; }
HAL_StatusTypeDef HAL_TIM_PWM_Stop(TIM_HandleTypeDef *htim, uint32_t ch){ (void)ch; if (htim == &htim2) emu_disp_on = 0; return HAL_OK; }
int emu_display_on(void){ return emu_disp_on; }

void emu_tick(void){
  colon_dma_ms++;               /* the colon DMA free-runs in the SysTick (1 ms) domain */
#ifdef EMU_NATIVE64
  if (g_systick) g_systick();
#else
  void (*h)(void) = (void(*)(void)) __VECTORS_RAM[ 16 + SysTick_IRQn ];
  if (h) h();
#endif
}
/* main-loop housekeeping the emulator needs each frame. Mirrors the firmware while(1): the astro
 * date-row modes recompute their payload via astro_update(); the alt time-row staging is always. */
void emu_poll(void){
  /* The deferred FATFS loader (checkDelayedLoadRules), ahead of alt_update as on the clock, so a
   * named zone2 (e.g. Europe/Madrid) resolves against /TZRULES.BIN and reaches the time row in the
   * same pass. The main zone is the app's (emu_load_zone / emu_set_tz_offset), so a pending
   * ZONE_OVERRIDE is held back rather than loaded over it. */
  if (delayedLoadZone2) { _Bool held = delayedLoadRules; delayedLoadRules = 0; checkDelayedLoadRules(); delayedLoadRules = held; }
#if EMU_HAS_ASTRO
  if (displayMode==MODE_SUN || displayMode==MODE_SUN_AZEL || displayMode==MODE_MOON
      || displayMode==MODE_GRID || displayMode==MODE_LATLON || displayMode==MODE_DARK) astro_update();
#endif
#if EMU_HAS_ALT
  alt_update();
#endif
#if EMU_HAS_CUCKOO
  cuckoo_poll();             /* scheduler + the 10 ms animation tick (main-loop work) */
#endif
#if EMU_HAS_SEGBAL
  segbal_poll();           /* per-segment brightness balance — same main-loop hook as hardware */
#endif
#if EMU_HAS_BRIT
  brightness_report_poll();   /* $PMBRIT once a second (brightness_report) — same main-loop hook */
#endif
#if EMU_HAS_STAR
  if (displayMode == MODE_STAR) star_update();   /* refresh the transit list, like astro_update */
#endif
  monitor_vbus();          /* process any VBUS (fold/power) connect/disconnect this pass */
}

/* --- interaction --- */
void emu_button1(void){ button1pressed(); }   /* nextMode forward */
void emu_button2(void){ button2pressed(); }   /* nextMode back */

/* On-device menu test harness: inject a date-board button byte (0x91..0x96) exactly as the USART2
 * ISR would, then run the main-loop FSM. decisec is forced out of the SysTick sendDate window so the
 * render is deterministic. emu_menu_tick advances uwTick to exercise the 15 s idle auto-exit. */
extern volatile uint32_t uwTick;
void emu_menu_event(uint8_t e){ menu_isr_event(e); decisec = 0; menu_poll(); }
void emu_menu_tick(uint32_t ms){ uwTick += ms; decisec = 0; menu_poll(); }
int  emu_menu_layer(void){ return (int)menu_layer; }
int  emu_menu_idx(void){ return (int)menu_idx; }
int  emu_menu_section(void){ return (int)menu_section; }   // v2 section ring cursor (SEC_*)
int  emu_tc_learn(void){ return (int)tc_learn; }            // TEMPCOMP toggle arms both learn...
int  emu_tc_apply(void){ return (int)tc_apply; }            // ...and apply
void emu_set_tc(int learn, int apply){ tc_learn = learn?1:0; tc_apply = apply?1:0; }  // scribble the live flags (test-only)
int  emu_seg_balance(void){ return (int)seg_balance; }      // BALANCE toggle drives both...
int  emu_colon_balance(void){ return (int)colon_balance; }  // ...seg and colon
void emu_set_balance(int seg, int col){ seg_balance = (uint16_t)seg; colon_balance = (uint16_t)col; }  // scribble (test-only)
int  emu_colon_scale(int dac){ return (int)colon_scale_for((int32_t)dac); }  // exercise the 2-anchor colon curve
int  emu_colon_preview(void){ return (int)colon_preview; }   // §3.5: 0xFF = no preview, else the previewed value (emu_colon_mode already exists below)
void emu_set_colon_anchors(int full_at, int floor){ colon_full_at = full_at; colon_floor = floor; }
int  emu_menu_modecount(void){ int n=0; for (int i=0;i<NUM_DISPLAY_MODES;i++) if (i!=MODE_STANDBY && config.modes_enabled[i]) n++; return n; }

/* Menu persistence test harness. The emu store is the NOR-true SETTINGS.BIN model in main.c
 * (ee_sfile[16K]: program ANDs bits, erase refills a 4 KB sector with 0xFF) — the same medium the
 * RC-silicon hardware uses, so persistence tests can no longer pass against physics the chip
 * doesn't have. emu_ee_reset re-provisions the file as flash.sh does (0xFF-filled). */
#ifdef __EMSCRIPTEN__
void   emu_ee_reset(void){ memset(ee_sfile,0xFF,sizeof ee_sfile); ee_load(); ee2_load(); }  /* fresh 0xFF file */
void   emu_ee_load(void){ ee_load(); ee2_load(); }                            /* re-scan (reboot) */
int    emu_ee_commit(void){ int r=(int)ee_commit(); if(r) menu_dirty=0; return r; }
void   emu_ee_apply(void){ menu_apply_overrides(); }
/* Record a display-mode enable into the override store via the firmware's OWN menu_record_key
 * path — validates the u64 mode-mask persistence for ordinals >= 32 (ZONE2/RELATIV/HOLD). */
void   emu_record_mode(int m,int on){ if(m<0||m>=NUM_DISPLAY_MODES) return; config.modes_enabled[m]=on?1:0; menu_record_key(KID_MODE_BASE+m,on?1:0); }
int    emu_mode_enabled(int m){ return (m>=0 && m<NUM_DISPLAY_MODES) ? config.modes_enabled[m] : -1; }
/* MODE_DARK twilight-ladder cache read-outs (local minutes-of-day, -1 = n/a). */
int    emu_astro_set(void){ return astro.set_min; }
int    emu_astro_noon(void){ return astro.noon_min; }
int    emu_dark_civ(void){ return astro.civ_dusk_min; }
int    emu_dark_nau(void){ return astro.nau_dusk_min; }
int    emu_dark_ast_dusk(void){ return astro.ast_dusk_min; }
int    emu_dark_ast_dawn(void){ return astro.ast_dawn_min; }
int    emu_dark_flags(void){ return (astro.dark_tonight?1:0) | (astro.always_dark?2:0); }
void   emu_ovr_clear(void){ memset((void*)&ovr,0,sizeof ovr); }              /* simulate RAM loss */
int    emu_ovr_valid(void){ return ovr.valid; }
void   emu_set_mtime(int fd,int ft){ config.fdate=(unsigned short)fd; config.ftime=(unsigned short)ft; }
void   emu_cfg_defined(unsigned s, unsigned m){ cfg_simple_defined=(uint16_t)s; cfg_modes_defined=m; }  // u16: KIDs 8/9 (MATRIX/TEMPCOMP) live above bit 7
double emu_brightness(void){ return (double)config.brightness_override; }
void   emu_set_brightness(double v){ config.brightness_override=(float)v; }
int    emu_ee_peek(unsigned off){ return off<sizeof(ee_sfile)?ee_sfile[off]:-1; }
void   emu_ee_poke(unsigned off,int v){ if(off<sizeof(ee_sfile)) ee_sfile[off]=(uint8_t)v; }
/* SETTINGS.BIN scenario controls (drive ee_init_base's resolver on the NEXT emu_ee_load):
 *   attach(1,0,0xFF) = provisioned card (default) | attach(0,..) = no file -> RAM-only |
 *   attach(1,1,..)   = fragmented file -> resolver rejects -> RAM-only |
 *   attach(1,0,0x00) = naive 0x00-filled provisioning -> first-use erase must recover it. */
void   emu_settings_attach(int attached, int fragmented, int fill){
  ee_sfile_attached=(uint8_t)attached; ee_sfile_frag=(uint8_t)fragmented;
  memset(ee_sfile,(uint8_t)fill,sizeof ee_sfile);
}
/* Simulate a host MSC write: scribble the region AND bump the mapping generation (as
 * STORAGE_Write_FS does) so the next commit is forced through settings_mapping_ok(). */
void   emu_settings_host_write(unsigned off, unsigned len, int val){
  for (unsigned i=0; i<len && off+i<sizeof ee_sfile; i++) ee_sfile[off+i]=(uint8_t)val;
  settings_map_gen++;
}
int    emu_ee_backing(void){ return (int)ee_backing; }        /* 0 NONE / 1 QSPI */
int    emu_ee_sfile_state(void){ return (int)ee_sfile_state; }/* 0 no file / 1 ok / 2 fragmented */
int    emu_ee_next(void){ return (int)ee_next; }              /* append cursor (skip-to-blank checks) */
/* QSPI read-fault injection (settings_rdfault_check): while on, every store read fails the way a HAL
 * QSPI error does on the clock - zeros come back. Firmware older than the fix has no injector. */
#if EMU_HAS_EE_RDFAULT
void   emu_settings_rdfault(int on){ ee_sfile_rdfault = on ? 1 : 0; }
#else
void   emu_settings_rdfault(int on){ (void)on; }
#endif
int    emu_menu_dirty(void){ return menu_dirty; }
int    emu_menu_val(void){ return (int)menu_val; }   /* raw editor value (display renders unit forms) */
void   emu_factory_reset(void){ factory_reset_pending = 1; factory_reset_step(); }   /* factory-reset the menu store */
int    emu_factory_reset_pending(void){ return factory_reset_pending; }           /* SYS>RESET confirm sets this */
void   emu_factory_reset_step(void){ factory_reset_step(); }                      /* service it (the main loop does this on hardware) */
/* Menu-commit-gate regression harness (the PPS-latch bug). The gate in menu_poll only fires when the
 * display UART is idle (huart2.gState READY — zero-init RESET here, so it must be armed) AND no real
 * $PMTXTS emit is pending. pps_record_pending latches high on any PPS-locked clock, so the gate must
 * key off pps_emit_pending() (pps_ts_enabled && pps_record_pending), not the raw flag. */
void   emu_set_uart_ready(int ready){ huart2.gState = ready ? HAL_UART_STATE_READY : HAL_UART_STATE_RESET; }
void   emu_set_pps(int enabled, int pending){ pps_ts_enabled = enabled?1:0; pps_record_pending = pending?1:0; }

/* Tempcomp retained-model persistence harness — the ee2 store is the UPPER HALF of the shared
 * SETTINGS.BIN model (ee_sfile[0x2000..0x3FFF]; the menu pair owns the lower half). Exercises:
 * commit a learned model -> "power cycle" -> the boot seed sequence restores it; config.txt
 * precedence; corrupt/implausible-model rejection; tc_forget. Peek/poke offsets stay RELATIVE to
 * the ee2 region so existing tests keep addressing record bytes the same way.
 * Guarded by EMU_HAS_TC_PERSIST (not EMU_HAS_TEMPCOMP): a branch can have tempcomp WITHOUT the ee2
 * persistence layer (e.g. the menu PR branch or PR #9's tempcomp), and these hooks reference tc2/ee2. */
#if EMU_HAS_TC_PERSIST
#define EE2_EMU_OFF 0x2000u
void   emu_ee2_reset(void){
  if (ee_backing == EE_BK_NONE) ee_init_base();          /* resolver first: ee2 bases derive from it */
  memset(&ee_sfile[EE2_EMU_OFF], 0xFF, sizeof(ee_sfile) - EE2_EMU_OFF);
  ee2_load();
}
void   emu_ee2_load(void){
  if (ee_backing == EE_BK_NONE) ee_init_base();
  ee2_load();                                            /* re-scan (reboot) */
}
#if EMU_HAS_FW_PERSIST
int    emu_ee2_commit(void){ return (int)ee2_commit(1); }
/* Wander persistence harness (fade_persist_check): inject a learned level as the learner would leave
 * it, run the real persist step, and read back what the store shadow and the learner hold. A
 * "power cycle" clears the learner and the once-per-boot latch, re-scans the store, and runs the
 * boot restore. emu_uptime advances the millisecond tick the 30-minute commit throttle runs on. */
void   emu_fw_set(double var, int count){ fw_var = (float)var; fw_count = (uint16_t)count; fw_new_pair = 1; }
void   emu_tc_persist_step(void){ tc_persist_step(); }
void   emu_fw_power_cycle(void){ fw_break(); fw_var = 0; fw_count = 0; fw_new_pair = 0; fw_dirty = 0; fw_restored = 0; tc_last_commit_ms = uwTick; ee2_load(); fw_restore_from_flash(); }
int    emu_fw_stored_count(void){ return fw2.count; }
double emu_fw_stored_var(void){ return (double)fw2.var; }
int    emu_fw_dirty(void){ return fw_dirty; }
int    emu_ee2_gen(void){ return (int)ee2_gen; }
void   emu_uptime(unsigned ms){ uwTick += ms; }
void   emu_tc_housekeeping(void){ tc_housekeeping(); tc_forget_step(); }
#else
int    emu_ee2_commit(void){ return (int)ee2_commit(); }
void   emu_fw_set(double var, int count){ (void)var; (void)count; }
void   emu_tc_persist_step(void){}
void   emu_fw_power_cycle(void){}
int    emu_fw_stored_count(void){ return 0; }
double emu_fw_stored_var(void){ return 0; }
int    emu_fw_dirty(void){ return 0; }
int    emu_ee2_gen(void){ return 0; }
void   emu_uptime(unsigned ms){ (void)ms; }
void   emu_tc_housekeeping(void){}
#endif
int    emu_ee2_peek(unsigned off){ off += EE2_EMU_OFF; return off<sizeof(ee_sfile)?ee_sfile[off]:-1; }
void   emu_ee2_poke(unsigned off,int v){ off += EE2_EMU_OFF; if(off<sizeof(ee_sfile)) ee_sfile[off]=(uint8_t)v; }
void   emu_tc_persist_set(int on){ tc_persist = on?1:0; }
int    emu_tc_persist_get(void){ return (int)tc_persist; }
void   emu_tc_seed_flag(int on){ tc_seed = on?1:0; }
void   emu_cfg_tc_defined(unsigned mask){ cfg_tc_defined = (uint8_t)mask; }
void   emu_tc_forget(void){ tc_forget_pending = 1; tc_forget_step(); }
int    emu_tc_model_dirty(void){ return tc_model_dirty; }
void   emu_tc_model_check(void){ tc_model_check(); }
int    emu_tc_model_supported(void){ return (int)tc_model_supported(); }
/* Inject a synthetic well-supported learned HSE model (ppm-domain coefficients), as if hours of
 * learning + tc_fit had produced it, so persistence can be exercised in a single call. */
void   emu_tc_set_model(double hse_b, double hse_c, int lo, int hi, int n_hse, double resid_ppm){
  float tpp = (float)tc_tpp(); if (tpp<=0.0f) tpp = 80.0f;
  tc_hse_m[0]=0.0f; tc_hse_m[1]=(float)hse_b*tpp; tc_hse_m[2]=(float)hse_c*tpp;
  tc_hse_tmin=(int16_t)lo; tc_hse_tmax=(int16_t)hi; tc_hse_valid=1; tc_hse_prior=3;
  tc_n_hse=(uint32_t)n_hse; tc_hse_resid=(float)resid_ppm*tpp;
}
void   emu_tc_clear_model(void){    /* simulate the power-on .bss clear, but keep the settings file (flash) */
  tc_hse_valid=tc_lse_valid=0; tc_hse_m[0]=tc_hse_m[1]=tc_hse_m[2]=0.0f;
  tc_hse_prior=tc_lse_prior=0; tc_n_hse=tc_n_lse=0; tc_hse_resid=tc_lse_resid=0.0f;
  tc_seed=0; tc_seed_done=0; tc_persist_seeded=0; tc_model_dirty=0;
  tc_cfg_hse[0]=tc_cfg_hse[1]=tc_cfg_hse[2]=NAN; tc_cfg_lse[0]=tc_cfg_lse[1]=tc_cfg_lse[2]=NAN;
}
/* Run the exact boot seed sequence readConfigFile now performs (flash seed -> apply -> after-seed). */
void   emu_tc_seed_boot(void){ tc_seed_from_flash(); tc_seed_apply(); tc_persist_after_seed(); }
/* Probe the loaded flash shadow (tc2) after a scan, to check what a re-scan restored. */
double emu_tc2_probe(int field){
  switch(field){
    case 0: return tc2.valid;     case 1: return tc2.hse_valid; case 2: return tc2.lse_valid;
    case 3: return tc2.hse_b;     case 4: return tc2.hse_c;     case 5: return tc2.lo;
    case 6: return tc2.hi;        case 7: return (double)tc2.n_hse; case 8: return tc2.t0;
    default: return 0;
  }
}
#else   /* branch without the ee2 persistence layer: keep the exported symbols resolvable as no-ops */
void   emu_ee2_reset(void){}
void   emu_ee2_load(void){}
int    emu_ee2_commit(void){ return 0; }
void   emu_fw_set(double var, int count){ (void)var; (void)count; }   /* lean branch: no store, no wander persistence */
void   emu_tc_persist_step(void){}
void   emu_fw_power_cycle(void){}
int    emu_fw_stored_count(void){ return 0; }
double emu_fw_stored_var(void){ return 0; }
int    emu_fw_dirty(void){ return 0; }
int    emu_ee2_gen(void){ return 0; }
void   emu_uptime(unsigned ms){ (void)ms; }
void   emu_tc_housekeeping(void){}
int    emu_ee2_peek(unsigned off){ (void)off; return -1; }
void   emu_ee2_poke(unsigned off,int v){ (void)off; (void)v; }
void   emu_tc_persist_set(int on){ (void)on; }
int    emu_tc_persist_get(void){ return 0; }
void   emu_tc_seed_flag(int on){ (void)on; }
void   emu_cfg_tc_defined(unsigned mask){ (void)mask; }
void   emu_tc_forget(void){}
int    emu_tc_model_dirty(void){ return 0; }
void   emu_tc_model_check(void){}
int    emu_tc_model_supported(void){ return 0; }
void   emu_tc_set_model(double b,double c,int lo,int hi,int n,double r){ (void)b;(void)c;(void)lo;(void)hi;(void)n;(void)r; }
void   emu_tc_clear_model(void){}
void   emu_tc_seed_boot(void){}
double emu_tc2_probe(int field){ (void)field; return 0; }
#endif
#endif
void emu_enable_mode(int m){ if (m>=0 && m<NUM_DISPLAY_MODES) config.modes_enabled[m] = 1; }
void emu_set_pos(float lat, float lon){ latitude = lat; longitude = lon; }
int  emu_mode(void){ return displayMode; }
/* Resolve a MODE_ constant NAME to its firmware enum value, so the JS face can map the
 * emulator's live displayMode (which the two cover buttons step in firmware-enum order,
 * exactly like the hardware) back to the app's mode key — instead of running a second,
 * app-order cursor that silently desynced the label from the segments. Emu-only shim;
 * the real firmware never needs a name table. Guards mirror the per-mode exports below.
 * Must cover the WHOLE enum, not just the face-cycle modes: the SETTINGS.BIN override
 * panel labels menu-store rows through this table, and any miss renders as "MODE #n". */
int emu_mode_id(const char* name){
  if (!name) return -1;
  #define M(n) if (!strcmp(name, #n)) return n;
  M(MODE_ISO8601_STD) M(MODE_ISO_ORDINAL) M(MODE_ISO_WEEK) M(MODE_UNIX)
  M(MODE_JULIAN_DATE) M(MODE_MODIFIED_JD) M(MODE_SHOW_OFFSET) M(MODE_SHOW_TZ_NAME)
  M(MODE_WEEKDAY) M(MODE_WEEKDA_DD) M(MODE_WDY_MM_DD)
  M(MODE_STANDBY) M(MODE_COUNTDOWN) M(MODE_SATVIEW) M(MODE_DEBUG_BRIGHTNESS)
  M(MODE_DEBUG_RTC) M(MODE_TEXT) M(MODE_FIRMWARE_CRC_T) M(MODE_FIRMWARE_CRC_D)
  M(MODE_VBAT) M(MODE_DISPLAYTEST) M(MODE_TTFF)
  M(MODE_SUN) M(MODE_SUN_AZEL) M(MODE_MOON) M(MODE_GRID) M(MODE_LATLON) M(MODE_TEMPCOMP)
  #if EMU_HAS_ALT
  M(MODE_LST) M(MODE_SOLAR)
  #endif
  #if EMU_HAS_ADEV
  M(MODE_ADEV)
  #endif
  #if EMU_HAS_STAR
  M(MODE_STAR)
  #endif
  M(MODE_ZONE2) M(MODE_DARK)
  #undef M
  return -1;
}
#if EMU_HAS_ALT
int  emu_MODE_LST(void){ return MODE_LST; }
int  emu_MODE_SOLAR(void){ return MODE_SOLAR; }
#else
int  emu_MODE_LST(void){ return -1; }     /* lean branch: sidereal modes absent */
int  emu_MODE_SOLAR(void){ return -1; }
#endif
#if EMU_HAS_ADEV
int  emu_MODE_ADEV(void){ return MODE_ADEV; }
#else
int  emu_MODE_ADEV(void){ return -1; }    /* lean branch: no Allan-deviation engine/mode */
#endif
#if EMU_HAS_STAR
int    emu_MODE_STAR(void){ return MODE_STAR; }
double emu_lst(double unix_s, double lon){ return local_sidereal_time(unix_s, lon); }  /* oracle hook */
int    emu_star_count(void){ return (int)star_count; }                                 /* loaded catalogue read-out (SD or default) */
float  emu_star_ra(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].ra  : -1.0f; }
float  emu_star_dec(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].dec : -999.0f; }
int    emu_star_pmra(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].pmra  : 0; }   /* mas/yr, mu_alpha* */
int    emu_star_pmdec(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].pmdec : 0; }
float  emu_star_ra_now(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].ra_now  : -1.0f; }   /* apparent of date */
float  emu_star_dec_now(int i){ return (i >= 0 && i < (int)star_count) ? star_buf[i].dec_now : -999.0f; }
void   emu_star_refresh(void){ star_refresh_apparent(); }                               /* force the daily apparent-place refresh */
int    emu_star_from_card(void){ return star_count > 0 ? 1 : 0; }                       /* single-source now: loaded == from the file (no baked fallback) */
void   emu_load_stars(void){ loadStars(); }        /* re-scan /STARS.BIN (register the file first); falls back to the baked set */
void   emu_star_max_mag(float m){ star_max_mag = m; }
const char* emu_star_name(int i){ static char b[5]; if (i<0||i>=(int)star_count) return ""; memcpy(b,star_buf[i].nm,4); b[4]=0; return b; }
#else
int    emu_MODE_STAR(void){ return -1; }  /* lean branch: no star-transit engine/mode */
double emu_lst(double unix_s, double lon){ (void)unix_s; (void)lon; return -1.0; }
int    emu_star_count(void){ return 0; }
float  emu_star_ra(int i){ (void)i; return -1.0f; }
float  emu_star_dec(int i){ (void)i; return -999.0f; }
int    emu_star_pmra(int i){ (void)i; return 0; }
int    emu_star_pmdec(int i){ (void)i; return 0; }
float  emu_star_ra_now(int i){ (void)i; return -1.0f; }
float  emu_star_dec_now(int i){ (void)i; return -999.0f; }
void   emu_star_refresh(void){}
int    emu_star_from_card(void){ return 0; }
void   emu_load_stars(void){}
void   emu_star_max_mag(float m){ (void)m; }
const char* emu_star_name(int i){ (void)i; return ""; }
#endif

/* --- brightness inject: firmware reads ADC1 (phototransistor); make it settable --- */
static uint32_t emu_adc = 2048;
void emu_set_adc(unsigned int v){ emu_adc = v; ADC1->DR = v; }   /* the dimmer loop and $PMBRIT read the register itself */
void emu_set_dac(unsigned int v){ dac_target = (float)v; }   /* rail level: 4095 = dimmest (segbal tests) */
uint32_t HAL_ADC_GetValue(ADC_HandleTypeDef* h){ (void)h; return emu_adc; }

/* ================= PHASE 2 — virtual GPS: feed the REAL NMEA parser + PPS =================
 * A synthetic GPS (sim.js) delivers NMEA sentences and PPS edges. We drive them into the
 * firmware's own reception seams so decodeRMC/decodeGSV/PPS/setPrecision run for real:
 *   - NMEA: stage the nmea[] scratch buffer + dispatch exactly like USART1_IRQHandler
 *   - PPS : call the currently-installed EXTI9_5 handler via the vector table (SetPPS target)
 *   - per-second engine: PendSV_Handler is not in this TU, but loadNextTimestamp() sets the
 *     real SCB->ICSR PENDSVSET bit at every second boundary; we dispatch its body off that.
 */

/* Cold power-on: no fix, no pulse, no position. Free-runs coarse (P0) until the sim locks it. */
void emu_boot_cold(unsigned int t){
  huart2.Instance = USART2;   /* see emu_boot: keep sendLatch()'s huart2.Instance->TDR off NULL */
  currentTime = (time_t)t; last_pps_time = 0; rtc_last_calibration = 0;
  had_pps = 0; data_valid = 0; rtc_good = 0; new_position = 1;
  displayMode = MODE_ISO8601_STD; countMode = COUNT_NORMAL;
  config.tolerance_1ms = 1000; config.tolerance_10ms = 10000; config.tolerance_100ms = 100000;
  config.brightness_override = -1.0f;   /* AUTO: readConfigFile's reset, before any config line */
  config.modes_enabled[MODE_ISO8601_STD] = 1;
  latitude = 0.0f; longitude = 0.0f;
  emu_disp_on = 1;
  /* ZONE 2 globals are .data on silicon — power-on restores their initialisers. Mirror that. */
  loadedZone2[0] = 0; offset2 = 0; zone2_fixed = 0; delayedLoadZone2 = 0; preloadZone2[0] = 0;
  delayedLoadRules = 0;   /* likewise a ZONE_OVERRIDE that emu_poll held back: power-on drops it */
  for (int i=0;i<SV_COUNT;i++) satview[i] = 255;   /* nothing in view yet */
  satview_stale = 0;
  /* Tempcomp learned state is .bss/.data on real silicon — a power-on clears it and the startup
   * copy restores the NAN-initialised config slots. Mirror that so a sim reboot re-learns (and
   * re-seeds) from scratch instead of inheriting the previous run. tc_nom_load models the 80 MHz
   * SysTick reload the firmware captures on hardware, so tc_tpp() = 80 (else the tick-domain HSE
   * model degenerates to 0). Set SysTick->LOAD (as SystemClock_Config does on hardware) but leave
   * tc_nom_load == 0, exactly as at power-on, so tc_seed_apply / tc_housekeeping capture it themselves
   * — that way the emulator exercises the real boot ordering rather than masking it. */
  SysTick->LOAD = 79999;
#if EMU_HAS_TEMPCOMP
  tc_nom_load = 0;
  tc_hse_valid = tc_lse_valid = 0; tc_hse_prior = tc_lse_prior = 0; tc_seed_done = 0;
  tc_hse_m[0]=tc_hse_m[1]=tc_hse_m[2]=0; tc_lse_m[0]=tc_lse_m[1]=tc_lse_m[2]=0;
  tc_cfg_hse[0]=tc_cfg_hse[1]=tc_cfg_hse[2]=NAN; tc_cfg_lse[0]=tc_cfg_lse[1]=tc_cfg_lse[2]=NAN;
  tc_hse_tmin=tc_hse_tmax=tc_lse_tmin=tc_lse_tmax=0;
  tc_hse_resid=tc_lse_resid=0; tc_n_hse=tc_n_lse=0;
  tc_seed=0; tc_seed_pending=0; tc_seed_lo=tc_seed_hi=0; tc_learn=tc_apply=tc_rtc=0; tc_disp_state='-';
  for (int i=0;i<40;i++){ tc_bins[i].hse_sum=tc_bins[i].lse_sum=0; tc_bins[i].hse_n=tc_bins[i].lse_n=0; }
#endif
#if EMU_HAS_BRIT
  brightness_report = 0; brit_win = 0;   /* power-on: the $PMBRIT switch is off, as .data restores it */
#endif
  ADC1->DR = emu_adc;           /* power-on: the sensor register holds what HAL_ADC_GetValue reports */
  colon_dma_ms = 0;             /* power-on: colon DMA starts from table index 0 */
  setNextTimestamp(currentTime);
  SetPPS( &PPS );          /* PPS_Init's job: COUNT_NORMAL setPrecision never installs one */
  setPrecision();
}

/* Config-load complete. The real firmware runs the post-config steps (incl. the tempcomp warm-start
 * seed) at the end of readConfigFile; the emulator streams config lines through emu_config_line()
 * instead, so the driver calls this once after the last line to fire the same post-config hook. */
#if EMU_HAS_TEMPCOMP
void emu_config_done(void){ tc_seed_apply(); }
#else
void emu_config_done(void){}
#endif

/* Conformance test hooks (tempcomp evolve): inject synthetic HSE samples into a die-temp bin and
 * force a refit, so the warm-start prior's preserve-then-hand-over behaviour can be exercised without
 * driving hours of PPS + temperature through the sim. hse_e is the per-sample tick error (≈ ppm·tpp). */
#if EMU_HAS_TEMPCOMP
void emu_tc_fill(int temp, int hse_e, int n){ struct tc_bin *b = &tc_bins[tc_bin_i(temp)]; b->hse_sum += (int32_t)hse_e * n; b->hse_n += n; tc_n_hse += n; }
void emu_tc_refit(void){ tc_fit(); }
#else
void emu_tc_fill(int temp, int hse_e, int n){ (void)temp; (void)hse_e; (void)n; }
void emu_tc_refit(void){}
#endif

/* Test hook (conformance only): jump the clock into N seconds of holdover without ticking N
 * seconds, so the precision ladder P3->P2->P1->P0 can be exercised cheaply. Sets last_pps_time
 * and the RTC calibration age to currentTime-secs, then re-evaluates precision — exactly the
 * state the firmware reaches after `secs` real seconds with no PPS. */
void emu_force_holdover(unsigned secs){
  last_pps_time = (uint32_t)currentTime - secs;
  rtc_last_calibration = (uint32_t)currentTime - secs;
  had_pps = 1;
  setPrecision();
#if EMU_HAS_TEMPCOMP
  if (significance_fade) computeHoldoverFade();   /* refresh digit_bright[] at the forced age */
#endif
}
/* Two-axis holdover: age the PPS and the RTC calibration INDEPENDENTLY. The precision ladder is
 * asymmetric — P3/P2 gate on last_pps_time, but P1 gates on rtc_last_calibration — so this is
 * needed to exercise the P1 branch's distinct dependence (a swapped/broken RTC comparison). */
void emu_force_holdover2(unsigned pps_secs, unsigned cal_secs){
  last_pps_time = (uint32_t)currentTime - pps_secs;
  rtc_last_calibration = (uint32_t)currentTime - cal_secs;
  had_pps = 1;
  setPrecision();
#if EMU_HAS_TEMPCOMP
  if (significance_fade) computeHoldoverFade();   /* refresh digit_bright[] at the forced age */
#endif
}
/* Regression hooks (holdover_fade_check / menu_undo_check).
 * emu_set_lse_cal puts the LSE side in the state a learning clock reaches: a valid LSE model, and the
 * raw LSE cycle error of the last RTC calibration (debug_rtc_val: 39 counts over 63 s = 18.9 ppm, a
 * typical 32 kHz crystal). It also captures the SysTick period the way tc_housekeeping does, so
 * tc_tpp() is 80 and the HSE residual reads in ppm. emu_count_mode is the COUNT_* the time row runs. */
#if EMU_HAS_TEMPCOMP
void emu_set_lse_cal(int valid, int rtc_val){
  tc_lse_valid = valid ? 1 : 0; debug_rtc_val = rtc_val;
  if (!tc_nom_load) tc_nom_load = SysTick->LOAD ? SysTick->LOAD : 79999u;
}
#else
void emu_set_lse_cal(int valid, int rtc_val){ (void)valid; (void)rtc_val; }
#endif
int emu_count_mode(void){ return countMode; }
/* Active colon animation + the civil/alt references. LST/SOLAR install colonModeAlt so the alt
 * timebases read as "not civil time" at a glance (an intentional honesty feature). */
int emu_colon_mode(void){ return colonMode; }
/* The colon DMA read index (see the colon DMA model above emu_tick): free-running 10 ms steps,
 * zeroed by the firmware's own colonAnimationSync() at even-second PPS. This is the index the
 * hardware DMA would be reading — NOT a reconstruction from currentTime parity, which flips
 * mid-second (.900 prep, RMC decode) and chopped the animation into segments. */
/* --- Cuckoo flourishes (CUCKOO_SPEC.md v2; cuckoo-v2 branch only) -------------------------
 * v2 is per-DIGIT: the engine writes ck_bright[row] (0..16) which segbal composes into the
 * dither duty, exactly like emu_digit_fade renders the significance fade. The face multiplies
 * its digit rendering by emu_cuckoo_level. emu_cuckoo_set is the test hook: op 99 force-starts
 * the piece named by `anim` (0 off, 1 carry, 2 heartbeat, 3 pendulum, 4 trust), op 98
 * force-starts the NOD; any other op just sets the `cuckoo` config value. */
int emu_cuckoo_active(void){
#if EMU_HAS_CUCKOO
  return (ck_anim == 0xFF) ? -1 : (int)ck_anim;  /* -1 idle; else the running piece (0xFE = nod) */
#else
  return -1;
#endif
}
int emu_cuckoo_level(int d, int s){
#if EMU_HAS_CUCKOO
  (void)s;                                       /* v2 is per-digit; s kept for ABI stability */
  if (ck_anim == 0xFF) return 16;                /* idle: the plain face is 'fully lit' */
  return (d >= 0 && d < CK_ROWS) ? ck_bright[d] : 16;
#else
  (void)d; (void)s; return 16;
#endif
}
int emu_cuckoo_setting(void){   /* the `cuckoo` config value (CK_OFF..), -1 without the feature */
#if EMU_HAS_CUCKOO
  return (int)cuckoo;
#else
  return -1;
#endif
}
void emu_cuckoo_set(int anim, int op){
#if EMU_HAS_CUCKOO
  if (anim >= 0 && anim < CK_PIECES) cuckoo = (uint8_t)anim;   /* 0 off, 1 trust (shipped catalogue) */
  if (op == 99 && cuckoo != CK_OFF) ck_start(cuckoo);
  else if (op == 98) ck_start(CK_NOD);
#else
  (void)anim; (void)op;
#endif
}

int emu_colon_step(void){
  return (int)((colon_dma_ms / 10u) % 200u);
}
#if EMU_HAS_ALT
int emu_colon_civil(void){ return colonModeCivil; }
int emu_colon_alt(void){ return colonModeAlt; }
#else
int emu_colon_civil(void){ return colonMode; }   /* lean branch: one colon mode, no alt staging */
int emu_colon_alt(void){ return colonMode; }
#endif
/* Named mode ids — reference these instead of magic numbers that rot if the enum reorders. */
/* v2 has no showcase mode (deferred with the date-board extension); export kept for ABI. */
int emu_MODE_CUCKOO_SHOWCASE(void){ return -1; }
int emu_MODE_UNIX(void){ return MODE_UNIX; }
int emu_MODE_ISO_ORDINAL(void){ return MODE_ISO_ORDINAL; }
int emu_MODE_ISO_WEEK(void){ return MODE_ISO_WEEK; }
int emu_MODE_WEEKDAY(void){ return MODE_WEEKDAY; }
#if EMU_HAS_ASTRO
int emu_MODE_MOON(void){ return MODE_MOON; }
int emu_MODE_GRID(void){ return MODE_GRID; }
int emu_MODE_LATLON(void){ return MODE_LATLON; }
int emu_MODE_SUN(void){ return MODE_SUN; }
#else
int emu_MODE_MOON(void){ return -1; }     /* lean branch: astro pack absent */
int emu_MODE_GRID(void){ return -1; }
int emu_MODE_LATLON(void){ return -1; }
int emu_MODE_SUN(void){ return -1; }
#endif
int emu_MODE_JULIAN_DATE(void){ return MODE_JULIAN_DATE; }
int emu_MODE_MODIFIED_JD(void){ return MODE_MODIFIED_JD; }

/* $PMTXTS emit capture. The firmware's own emitPPSTimestamp() formats the timing sentence and
 * hands it to CDC_Copy_Transmit — stubbed to a no-op everywhere else. Here we give it a real
 * definition that lands the bytes in RAM, so the emulator can read back the firmware's OWN
 * byte-faithfully-formatted $PMTXTS (same snprintf, same NMEA checksum) for comparison against a
 * bench capture. (Replaces the stubs.js no-op; native_stubs.c's copy is weak so this wins there.) */
static char emu_pmtxts_buf[224];   /* $PMSTAR with 8 x 4-field entries (~160 B) outgrew 128 */
static int emu_cdc_busy = 0;      /* test hook: the next N submits find the endpoint BUSY */
uint8_t CDC_Copy_Transmit(uint8_t* buf, uint16_t Len){
  if (emu_cdc_busy > 0) { emu_cdc_busy--; return USBD_BUSY; }
  uint16_t n = Len < (uint16_t)(sizeof(emu_pmtxts_buf)-1) ? Len : (uint16_t)(sizeof(emu_pmtxts_buf)-1);
  for (uint16_t i = 0; i < n; i++) emu_pmtxts_buf[i] = (char)buf[i];
  emu_pmtxts_buf[n] = 0;
  return 0;  /* USBD_OK */
}
/* Drive one $PMTXTS emit from the values captured at the last emu_pps() edge; return the sentence
 * (with trailing CR/LF), or "" if no record is pending. */
const char* emu_pmtxts_line(void){
#if EMU_HAS_TEMPCOMP   /* $PMTXTS ships with the PR #5+ branches; stock master has no emitter */
  emu_pmtxts_buf[0] = 0;
  pps_ts_enabled = 1;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;  /* satisfy emitPPSTimestamp's host-present gate */
  if (pps_record_pending) emitPPSTimestamp();
#else
  emu_pmtxts_buf[0] = 0;
#endif
  return emu_pmtxts_buf;
}
/* $PMBRIT: one emit through the firmware's own emitBrightnessReport() — like the other *_line helpers
 * it bypasses the switch and the 1 Hz window, so a check can read the format on demand. */
const char* emu_pmbrit_line(void){
  emu_pmtxts_buf[0] = 0;
#if EMU_HAS_BRIT
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;  /* satisfy the host-present gate */
  emitBrightnessReport();
#endif
  return emu_pmtxts_buf;
}
/* "menu_dump = on": one emit through the firmware's own menu_dump_step(), so a check can read the
 * store diagnostic for each SETTINGS.BIN state. Empty string = the firmware dropped the line. */
const char* emu_menu_dump_line(void){
  emu_pmtxts_buf[0] = 0;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  menu_dump_pending = 1;
  menu_dump_step();
  return emu_pmtxts_buf;
}
/* config.txt reload harness (config_reload_check). emu_read_config runs the firmware's real
 * readConfigFile against a registered /CONFIG.TXT. emu_cfg_peek reads one piece of config-owned
 * state by name, so a check can compare "this key was removed" with "this key was never set".
 * (emu_read_config itself sits with the file shim, further down.) */
void emu_zone_looked_up(double lat, double lon){ zone_lat = lat; zone_lon = lon; new_position = 0; }   /* as the main loop leaves it after a timezone lookup */
#if EMU_HAS_CFG_REDERIVE
int emu_cfg_rows(void){ return (int)CFG_ROWS; }
const char* emu_cfg_row_key(int i){ return (i >= 0 && i < (int)CFG_ROWS) ? cfg_defaults[i].key : ""; }
#else
int emu_cfg_rows(void){ return 0; }
const char* emu_cfg_row_key(int i){ (void)i; return ""; }
#endif
double emu_cfg_peek(const char* n){
  #define P(name, expr) if (!strcmp(n, name)) return (double)(expr);
  P("pps", pps_ts_enabled) P("nmea", nmea_cdc_level) P("page_ms", config.page_ms) P("text_len", strlen(textDisplay))
  P("fake_longitude", config.fake_long) P("fake_latitude", config.fake_lat) P("countdown_to", (double)config.countdown_to)
  P("brightness", config.brightness_override) P("tolerance_1ms", config.tolerance_1ms)
  P("colon_mode", colonModeCivil) P("zone_lat", zone_lat) P("new_position", new_position)
  P("zone2_set", loadedZone2[0] != 0) P("matrix", matrix_freq_hz)
  P("BS2_in", brightnessCurve[1].in) P("BS2_out", brightnessCurve[1].out)
#if EMU_HAS_SEGBAL
  P("seg_balance", seg_balance) P("colon_balance", colon_balance) P("colon_full_at", colon_full_at) P("colon_floor", colon_floor)
#endif
#if EMU_HAS_CUCKOO
  P("cuckoo", cuckoo)
#endif
#if EMU_HAS_TEMPCOMP
  P("tc_learn", tc_learn) P("tc_apply", tc_apply) P("tc_rtc", tc_rtc) P("significance_fade", significance_fade)
  P("tc_t0", tc_t0) P("tc_engage_s", tc_engage_s) P("tc_max_ppm", tc_max_ppm)
  P("tc_hse_b", tc_cfg_hse[1]) P("tc_lse_a", tc_cfg_lse[0]) P("tc_seed", tc_seed) P("tc_seed_lo", tc_seed_lo)
#endif
#if EMU_HAS_TC_PERSIST
  P("tc_persist", tc_persist)
#endif
#if EMU_HAS_STAR
  P("star_max_mag", star_max_mag)
#endif
#if EMU_HAS_BRIT
  P("brightness_report", brightness_report)
#endif
#if EMU_HAS_WDT
  P("watchdog", watchdog)
#endif
#if EMU_HAS_FREQ_HOLD
  P("freq_hold", freq_hold)
#endif
  P("loop_diag", loop_diag)
  #undef P
  if (!strncmp(n, "MODE:", 5)) { int m = emu_mode_id(n + 5); return (m >= 0 && m < NUM_DISPLAY_MODES) ? (double)config.modes_enabled[m] : -1.0; }
  return -12345.0;   /* unknown name: a check must notice */
}
/* Frequency-hold harness (freq_hold_check). An "edge" is one PPS: the DWT count advances by the
 * nominal 80,000,000 plus d ticks, and the firmware's own gate (freq_hold) and learner run, exactly
 * as tc_housekeeping does. A "second" advances the clock one second, locked (a PPS arrived) or in
 * holdover, runs the real governor, and returns the extra ticks the tick ISR would add across that
 * second: (LOAD - nominal) * 1000 + remainder. */
#if EMU_HAS_FREQ_HOLD
void emu_fh_reset(void){
  if (!tc_nom_load) tc_nom_load = 79999u;
  fh_count = fh_head = fh_n = 0; fh_sum = 0; fh_have_prev = 0; fh_warm = 0;
  for (unsigned i = 0; i < FH_BLOCKS; i++) fh_ring[i] = 0;
#if EMU_HAS_FADE_WANDER
  fw_break(); fw_var = 0; fw_count = 0;
#endif
}
#if EMU_HAS_FADE_WANDER
int    emu_fw_count(void){ return fw_count; }
double emu_fw_var(void){ return (double)fw_var; }          /* learned Allan variance at 1024 s, (ticks/s)^2 */
double emu_fw_used(void){ return (double)fade_wander_var(); }
#else
int    emu_fw_count(void){ return 0; }
double emu_fw_var(void){ return 0; }
double emu_fw_used(void){ return 0; }
#endif
void emu_fh_edge(int d, int valid){
  pps_cap.seq++; pps_cap.dwt_pps += (tc_nom_load + 1u) * 1000u + (uint32_t)d;
  pps_cap.flags = valid ? 3 : 0;
  if (freq_hold || significance_fade) fh_learn();
}
void emu_fh_missed_edge(void){ pps_cap.seq++; pps_cap.dwt_pps += (tc_nom_load + 1u) * 1000u; }   /* the main loop never saw it */
int  emu_fh_estimate(void){ int32_t e = 0; return fh_estimate(&e) ? (int)e : -2000000000; }
int  emu_fh_blocks(void){ return fh_count; }
void emu_fh_temp(int t){ die_temp_c = (int16_t)t; }
int  emu_fh_second(int locked){
  currentTime++; had_pps = 1;
  if (locked) last_pps_time = (uint32_t)currentTime;
  tc_governor();
  return tc_steer_on ? (int)((tc_load_base - (int32_t)tc_nom_load) * 1000 + tc_rem) : 0;
}
int  emu_fh_steering(void){ return tc_steer_on; }
double emu_fh_disp_ppm(void){ return tc_disp_hse_ok ? (double)tc_disp_hse : -999.0; }
void emu_tc_dump_start(void){ hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED; tc_dump_pending = 1; }
const char* emu_tc_dump_next(void){ emu_pmtxts_buf[0] = 0; tc_dump_step(); return emu_pmtxts_buf; }
#else
void emu_fh_reset(void){}
void emu_fh_edge(int d, int valid){ (void)d; (void)valid; }
void emu_fh_missed_edge(void){}
int  emu_fh_estimate(void){ return -2000000000; }
int  emu_fh_blocks(void){ return 0; }
void emu_fh_temp(int t){ (void)t; }
int  emu_fh_second(int locked){ (void)locked; return 0; }
int  emu_fh_steering(void){ return 0; }
double emu_fh_disp_ppm(void){ return -999.0; }
void emu_tc_dump_start(void){}
const char* emu_tc_dump_next(void){ return ""; }
#endif
/* Watchdog harness (wdt_check). The emulator has no IWDG, so the firmware counts its own start and
 * refresh calls here; everything else is the firmware's real accounting. A "reset" is emu_wdt_boot:
 * 1 = the watchdog fired, 0 = any other reset. emu_wdt_power_on fills the retained struct with
 * noise, as RAM2 holds after a power cycle. get: 0 armed, 1 stood down, 2 resets, 3 consecutive,
 * 4 last tag, 5 IWDG starts, 6 IWDG refreshes, 7 the config flag. */
#if EMU_HAS_WDT
void emu_wdt_power_on(void){ memset(&wdt_keep, 0xA5, sizeof wdt_keep); wdt_emu_starts = wdt_emu_kicks = 0; watchdog = 0; wdt_boot(0); }
void emu_wdt_boot(int was_wdt_reset){ wdt_boot(was_wdt_reset ? 1 : 0); }
void emu_wdt_poll(void){ wdt_poll(); }
void emu_wdt_tag(int n){ wdt_keep.tag = (uint8_t)n; }
void emu_wdt_advance(unsigned ms){ uwTick += ms; }
int  emu_wdt_get(int f){
  switch (f){
    case 0: return wdt_armed;          case 1: return wdt_stood_down;
    case 2: return wdt_keep.resets;    case 3: return wdt_keep.consecutive;
    case 4: return wdt_keep.last_tag;  case 5: return (int)wdt_emu_starts;
    case 6: return (int)wdt_emu_kicks; case 7: return watchdog;
  }
  return -1;
}
const char* emu_wdt_dump_line(void){
  emu_pmtxts_buf[0] = 0;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  wdt_dump_pending = 1;
  wdt_dump_step();
  return emu_pmtxts_buf;
}
#else
void emu_wdt_power_on(void){}
void emu_wdt_boot(int w){ (void)w; }
void emu_wdt_poll(void){}
void emu_wdt_tag(int n){ (void)n; }
void emu_wdt_advance(unsigned ms){ (void)ms; }
int  emu_wdt_get(int f){ (void)f; return -1; }
const char* emu_wdt_dump_line(void){ return ""; }
#endif
/* Read-and-clear the last CDC submit, so a check can let emu_poll pace a sentence and count what
 * actually went out. */
static char emu_take_buf[sizeof emu_pmtxts_buf];
const char* emu_cdc_take(void){ memcpy(emu_take_buf, emu_pmtxts_buf, sizeof emu_take_buf); emu_pmtxts_buf[0] = 0; return emu_take_buf; }
void emu_cdc_busy_next(int n){ emu_cdc_busy = n; }
void emu_usb_host(int on){ hUsbDeviceFS.dev_state = on ? USBD_STATE_CONFIGURED : USBD_STATE_DEFAULT; }
/* One pass of the firmware's own dimmer loop — the DAC DMA half-buffer callback: sensor -> BS curve ->
 * smoothed rail. The emulator never runs it by itself; checks call it to drive the real loop. */
void emu_dac_step(void){ static uint16_t b[DAC_BUFFER_SIZE]; generateDACbuffer(b); }
int  emu_brit_report(void){   /* the switch itself: serial, config or SYS > BRT MSG; -1 without it */
#if EMU_HAS_BRIT
  return brightness_report;
#else
  return -1;
#endif
}
double emu_dac_target(void){ return (double)dac_target; }   /* the rail as stored: 0 brightest .. 4095 dimmest */
/* colon_balance_poll() can't run here (NVIC isn't shimmed); set the applied scale it would land. */
void emu_set_colon_scale(int v){ colonScale = (uint16_t)v; }
/* Drive one $PMADEV emit from the current phase ring (whatever emu_adev_push has fed) and return the
 * sentence — the firmware's OWN adev_dump_step() formatting + NMEA checksum, byte-faithful. */
const char* emu_adev_line(void){
#if EMU_HAS_ADEV
  emu_pmtxts_buf[0] = 0;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;  /* satisfy adev_dump_step's host-present gate */
  adev_dump_pending = 1;
  adev_dump_step();                                /* builds + "sends" -> CDC shim -> emu_pmtxts_buf */
#else
  emu_pmtxts_buf[0] = 0;
#endif
  return emu_pmtxts_buf;
}
const char* emu_hdev_line(void){                   /* the Hadamard twin */
#if EMU_HAS_ADEV
  emu_pmtxts_buf[0] = 0;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  hdev_dump_pending = 1;
  hdev_dump_step();
#else
  emu_pmtxts_buf[0] = 0;
#endif
  return emu_pmtxts_buf;
}
/* Drive one $PMSTAR emit from the current fix + time (star_dump_step recomputes the transit list). */
const char* emu_star_line(void){
#if EMU_HAS_STAR
  emu_pmtxts_buf[0] = 0;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;
  star_dump_pending = 1;
  star_dump_step();
#else
  emu_pmtxts_buf[0] = 0;
#endif
  return emu_pmtxts_buf;
}

/* --- In-memory FATFS shim -----------------------------------------------------------------------
 * So the firmware's OWN loadRules() parses the REAL /TZRULES.BIN (MTZ format -> the 162-entry
 * rules[] DST table) and setNextTimestamp() applies byte-faithful IANA offsets across DST edges,
 * replacing the browser-Intl single-offset shim (emu_set_tz_offset). Files are registered from JS
 * (emu_register_file: a pointer into the wasm heap that JS keeps alive, + length). Only the four
 * calls loadRules uses are provided; their JS no-op stubs are removed from stubs.js so these win.
 * ZoneDetect / TZMAP.BIN (12 MB, mmap-based) is intentionally NOT shimmed — the manual zone path is
 * the byte-faithful rules engine; the auto-GPS-position map lookup stays a documented gap. */
#define EMU_VFS_MAX 4
static struct { char name[24]; const uint8_t* data; uint32_t size; } emu_vfs[EMU_VFS_MAX];
static int emu_vfs_n = 0;
static struct { FIL* fp; const uint8_t* data; uint32_t size; uint32_t pos; } emu_vopen[EMU_VFS_MAX];
static int emu_streq(const char* a, const char* b){ while (*a && *a == *b){ a++; b++; } return *a == *b; }

void emu_register_file(const char* name, const uint8_t* data, unsigned size){
  int slot = -1;
  for (int i = 0; i < emu_vfs_n; i++) if (emu_streq(emu_vfs[i].name, name)) slot = i;   /* replace on re-register */
  if (slot < 0){ if (emu_vfs_n >= EMU_VFS_MAX) return; slot = emu_vfs_n++; }
  int i = 0; for (; name[i] && i < 23; i++) emu_vfs[slot].name[i] = name[i];
  emu_vfs[slot].name[i] = 0; emu_vfs[slot].data = data; emu_vfs[slot].size = size;
}
FRESULT f_open(FIL* fp, const TCHAR* path, BYTE mode){
  (void)mode;
  for (int i = 0; i < emu_vfs_n; i++) if (emu_streq(emu_vfs[i].name, (const char*)path)){
    for (int j = 0; j < EMU_VFS_MAX; j++) if (!emu_vopen[j].fp || emu_vopen[j].fp == fp){
      emu_vopen[j].fp = fp; emu_vopen[j].data = emu_vfs[i].data; emu_vopen[j].size = emu_vfs[i].size; emu_vopen[j].pos = 0;
      fp->obj.objsize = emu_vfs[i].size; fp->fptr = 0;   /* so f_size(fp) (ZoneDetect uses it) is right */
      return FR_OK;
    }
    return FR_DISK_ERR;
  }
  return FR_NO_FILE;
}
FRESULT f_read(FIL* fp, void* buff, UINT btr, UINT* br){
  for (int j = 0; j < EMU_VFS_MAX; j++) if (emu_vopen[j].fp == fp){
    uint32_t n = btr; if (emu_vopen[j].pos + n > emu_vopen[j].size) n = emu_vopen[j].size - emu_vopen[j].pos;
    for (uint32_t k = 0; k < n; k++) ((uint8_t*)buff)[k] = emu_vopen[j].data[emu_vopen[j].pos + k];
    emu_vopen[j].pos += n; if (br) *br = n; return FR_OK;
  }
  if (br) *br = 0; return FR_DISK_ERR;
}
FRESULT f_lseek(FIL* fp, FSIZE_t ofs){
  for (int j = 0; j < EMU_VFS_MAX; j++) if (emu_vopen[j].fp == fp){ emu_vopen[j].pos = (uint32_t)ofs; return FR_OK; }
  return FR_DISK_ERR;
}
/* f_stat for the registered files, so the firmware's own readConfigFile runs here: its mtime test
 * decides whether a load happens at all. emu_file_mtime sets the stamp every file reports. */
static uint16_t emu_vfs_fdate = 0, emu_vfs_ftime = 0;
void emu_file_mtime(int fdate, int ftime){ emu_vfs_fdate = (uint16_t)fdate; emu_vfs_ftime = (uint16_t)ftime; }
void emu_file_remove(const char* name){
  for (int i = 0; i < emu_vfs_n; i++) if (emu_streq(emu_vfs[i].name, name)){ emu_vfs[i] = emu_vfs[--emu_vfs_n]; return; }
}
FRESULT f_stat(const TCHAR* path, FILINFO* fno){
  for (int i = 0; i < emu_vfs_n; i++) if (emu_streq(emu_vfs[i].name, (const char*)path)){
    if (fno){ fno->fsize = emu_vfs[i].size; fno->fdate = emu_vfs_fdate; fno->ftime = emu_vfs_ftime; }
    return FR_OK;
  }
  return FR_NO_FILE;
}
/* The firmware's real config loader, against a registered /CONFIG.TXT (it never closes the file). */
void emu_read_config(void){ for (int j = 0; j < EMU_VFS_MAX; j++) emu_vopen[j].fp = 0; readConfigFile(); }
FRESULT f_close(FIL* fp){
  for (int j = 0; j < EMU_VFS_MAX; j++) if (emu_vopen[j].fp == fp) emu_vopen[j].fp = 0;
  return FR_OK;
}
/* Load a zone via the firmware's OWN loadRulesSingle (splits "Region/City" on '/', calls loadRules
 * on TZRULES.BIN), then apply. Returns the firmware RULES_* code (0 = RULES_OK). */
int emu_load_zone(const char* zone){
  for (int j = 0; j < EMU_VFS_MAX; j++) emu_vopen[j].fp = 0;   /* loadRules leaks its FIL on error paths */
  char z[40]; int i = 0; for (; zone[i] && i < 39; i++) z[i] = zone[i]; z[i] = 0;
  int r = loadRulesSingle(z);
  setNextTimestamp(currentTime);
  return r;
}
/* One whole pass of the main loop's deferred FATFS loader (checkDelayedLoadRules): resolves a pending
 * ZONE_OVERRIDE / zone2 IANA name against the registered /TZRULES.BIN. emu_poll runs only its zone2
 * half, so checks call this where the hardware's main loop would load a ZONE_OVERRIDE. */
void emu_check_delayed_rules(void){ checkDelayedLoadRules(); }
/* The firmware's tz offset (seconds) that applies at epoch t — walks the loaded rules[] via the
 * real setNextTimestamp. */
int emu_offset_at(unsigned t){ setNextTimestamp((time_t)t); return currentOffset; }

/* Auto timezone from GPS position — the firmware's OWN path (main.c:3192): open /TZMAP.BIN, run
 * ZoneDetect on (lat,lon) to resolve the IANA zone name, then loadRulesSingle() applies that zone's
 * DST rules from /TZRULES.BIN. Both files must be registered first (emu_register_file). Returns the
 * resolved zone name (e.g. "Europe/London"), or "" if the lookup fails. ZoneDetect STREAMS the 12 MB
 * map through the firmware's 512-byte mapCache via f_read/f_lseek — it is never loaded whole. */
const char* emu_zone_from_pos(float lat, float lon){
  static char zonebuf[48];
  zonebuf[0] = 0;
  for (int j = 0; j < EMU_VFS_MAX; j++) emu_vopen[j].fp = 0;   /* clean slate (loadRulesSingle leaks its FIL on error) */
  FIL mapfile;
  if (f_open(&mapfile, MAP_FILENAME, FA_READ) != FR_OK) return zonebuf;
  ZoneDetect* zdb = ZDOpenDatabase(&mapfile);
  if (zdb){
    char* zone = ZDHelperSimpleLookupString(zdb, lat, lon);
    if (zone){
      int i = 0; for (; zone[i] && i < 47; i++) zonebuf[i] = zone[i]; zonebuf[i] = 0;
      loadRulesSingle(zone);            /* modifies zone in place; zonebuf already copied */
      free(zone);
      setNextTimestamp(currentTime);
    }
    ZDCloseDatabase(zdb);
  }
  f_close(&mapfile);
  return zonebuf;
}

/* Inject the SysTick down-counter value (0..LOAD) the next PPS edge will capture. The metrology
 * model (timing_model.mjs) draws this from the measured disciplined phase-jitter distribution so
 * the emulator's own $PMTXTS carries a realistic sub-second phase (systick) instead of 0 — the
 * "injectable jitter" that grounds the emitted timing. Set it right before emu_pps(). */
void emu_set_systick(unsigned v){ SysTick->VAL = v; }

/* Feed one NUL-terminated NMEA sentence. Mirrors the $Gx dispatch in USART1_IRQHandler. */
void emu_feed_nmea(const char* s){
  int len = 0; while (s[len] && len < (int)sizeof(nmea)) { nmea[len] = (uint8_t)s[len]; len++; }
  uint8_t rec = (uint8_t)len;   /* = sizeof(nmea) - CNDTR on HW: bytes incl trailing '\n' */
  if (nmea[0]=='$' && nmea[1]=='G' && nmea[3]=='R' && nmea[4]=='M' && nmea[5]=='C') {
    decodeRMC();
  } else if (nmea[0]=='$' && nmea[1]=='G' && nmea[3]=='G' && nmea[4]=='S' && nmea[5]=='V') {
    decodeGSV(rec);
  }
}

/* --- VBUS / power-presence shim (the "fold open/close" hook). monitor_vbus reads GPIOA PA8;
 * on the real device this gates the USB stack (enumerate vs charger-only). We drive that pin and
 * run monitor_vbus() from emu_poll so connect/disconnect follows the real firmware path. --- */
void emu_set_vbus(int connected){
  if (connected) GPIOA->IDR |= GPIO_PIN_8;
  else           GPIOA->IDR &= ~(uint32_t)GPIO_PIN_8;
}

/* --- Config shim: apply one config.txt / serial line THROUGH the real parser (rxConfigString ->
 * parseConfigString), then run postConfigCleanup exactly as the device does after a config write.
 * This is byte-faithful config handling — the same path that a serial "key = value" takes. The
 * caller must NOT pass "reboot" (rxConfigString would NVIC_SystemReset); orchestrate reboots in JS
 * (emu_boot_cold + replay the config lines). --- */
void emu_config_line(const char* line){
  for (const char* p = line; *p; p++) rxConfigString(*p);
  rxConfigString('\n');            /* terminate the line -> parseConfigString + defer cleanup */
  postConfigCleanup();             /* thread-context: nextMode/sendDate/colon/tolerances */
#if EMU_HAS_DELAYED_CLEANUP
  delayedPostConfigCleanup = 0;    /* hardened branches defer cleanup out of the ISR; ack it */
#endif
}

/* --- TIMEZONE shim. The real device populates rules[] two ways: loadRules() reading the DST
 * ruleset from /TZRULES.BIN, or ZoneDetect looking the zone up from GPS position in /TZMAP.BIN.
 * The emulator has NO FATFS, so neither path runs -> rules[] stays empty -> setNextTimestamp()
 * derives offset 0 -> the display is UTC. Inject ONE synthetic rule carrying the observer's
 * current UTC offset (seconds east of UTC, DST-aware, computed host-side from the browser's
 * IANA zone) in exactly the {t, offset} shape loadRules would write. The firmware's OWN
 * setNextTimestamp() then applies it -> the same currentOffset drives the displayed time, the
 * +HH:MM offset tell, and the astro sun/moon maths. offset==0 restores true UTC. --- */
void emu_set_tz_offset(int seconds){
  rules[0].t = 0;                  /* in force since the epoch */
  rules[0].offset = seconds;
  rules[1].t = (uint32_t)-1;       /* terminator: > any nextTime, so the offset loop stops here */
  setNextTimestamp(currentTime);   /* re-derive currentOffset + nextBcd through the real path */
}
/* The offset the firmware is currently applying (seconds). Lets the HUD show UTC vs local honestly. */
int emu_tz_offset(void){ return (int)currentOffset; }

/* One PPS rising edge -> whichever PPS variant setPrecision installed (PPS/NoUpdate/etc). */
void emu_pps(void){
#ifdef EMU_NATIVE64
  if (g_pps) g_pps();
#else
  void (*h)(void) = (void(*)(void)) __VECTORS_RAM[ 16 + EXTI9_5_IRQn ];
  if (h) h();
#endif
}

/* The per-second engine (PendSV body: re-evaluate precision + age the sat view). RTC write and
 * countdown-latch edge case are elided — invisible in the emulator. */
void emu_pendsv(void){
  setPrecision();
  if (resendDate || countMode == COUNT_HIDDEN) { sendDate(1); resendDate = 0; }
  if (satview_stale > 3){
    satview[SV_GPS_L1]=255; satview[SV_GPS_UNKNOWN]=255;
    satview[SV_GLONASS_L1]=255; satview[SV_GLONASS_UNKNOWN]=255;
    satview[SV_GALILEO_E1]=255; satview[SV_GALILEO_UNKNOWN]=255;
    satview[SV_BEIDOU_B1]=255; satview[SV_BEIDOU_UNKNOWN]=255;
  } else satview_stale++;
}
/* True (and self-clears) when the firmware requested PendSV since the last check. */
int emu_pendsv_pending(void){
  if (SCB->ICSR & SCB_ICSR_PENDSVSET_Msk){ SCB->ICSR &= ~SCB_ICSR_PENDSVSET_Msk; return 1; }
  return 0;
}

/* --- GPS state readout for the HUD --- */
unsigned emu_flags(void){ return (data_valid?1u:0u)|(had_pps?2u:0u)|(rtc_good?4u:0u); }
int      emu_data_valid(void){ return data_valid?1:0; }
int      emu_had_pps(void){ return had_pps?1:0; }
unsigned emu_since_pps(void){ return (unsigned)((uint32_t)currentTime - last_pps_time); }
unsigned emu_satcount(void){ unsigned n=0; for (int i=0;i<SV_COUNT;i++) if (satview[i]!=255) n+=satview[i]; return n; }
