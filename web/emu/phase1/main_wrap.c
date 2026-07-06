#include "main.h"
#include "fatfs.h"
#include "usb_device.h"
#include <stdio.h>
#include <string.h>
#include <time.h>
#include "qspi_drv.h"
#include "zonedetect.h"
#include "chainloader.h"
#include "astro.h"
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
unsigned char  emu_seg_c(void){ return next7seg.c; }
unsigned short emu_seg_b(int i){ return next7seg.b[i]; }
unsigned short emu_bufb(int i){ return buffer_b[i]; }
unsigned char  emu_bufc_low(int i){ return buffer_c[i].low; }
unsigned char  emu_bufc_high(int i){ return buffer_c[i].high; }
unsigned int   emu_now(void){ return (unsigned int)currentTime; }

/* --- boot a GPS-locked civil clock + 1 kHz tick dispatched through the real vector table --- */
void emu_boot(unsigned int t){
  huart2.Instance = USART2;   /* sendLatch() writes huart2.Instance->TDR (the date-board latch); MX
                               * init is stubbed so Instance is NULL -> point it at the shimmed USART2
                               * RAM struct. Meaningless in the emu (no date board), but stops the
                               * native twin faulting on a NULL->TDR (offset 0x28) store. */
  currentTime = (time_t)t; last_pps_time = (uint32_t)t; had_pps = 1;
  displayMode = MODE_ISO8601_STD; countMode = COUNT_NORMAL;
  config.tolerance_1ms = 1000; config.tolerance_10ms = 10000; config.tolerance_100ms = 100000;
  config.modes_enabled[MODE_ISO8601_STD] = 1;
  setNextTimestamp(currentTime);
  setPrecision();
}
void emu_tick(void){
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
  if (displayMode==MODE_SUN || displayMode==MODE_SUN_AZEL || displayMode==MODE_MOON
      || displayMode==MODE_GRID || displayMode==MODE_LATLON) astro_update();
  alt_update();
  monitor_vbus();          /* process any VBUS (fold/power) connect/disconnect this pass */
}

/* --- interaction --- */
void emu_button1(void){ button1pressed(); }   /* nextMode forward */
void emu_button2(void){ button2pressed(); }   /* nextMode back */
void emu_enable_mode(int m){ if (m>=0 && m<NUM_DISPLAY_MODES) config.modes_enabled[m] = 1; }
void emu_set_pos(float lat, float lon){ latitude = lat; longitude = lon; }
int  emu_mode(void){ return displayMode; }
int  emu_MODE_LST(void){ return MODE_LST; }
int  emu_MODE_SOLAR(void){ return MODE_SOLAR; }

/* --- brightness inject: firmware reads ADC1 (phototransistor); make it settable --- */
static uint32_t emu_adc = 2048;
void emu_set_adc(unsigned int v){ emu_adc = v; }
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
  config.modes_enabled[MODE_ISO8601_STD] = 1;
  latitude = 0.0f; longitude = 0.0f;
  for (int i=0;i<SV_COUNT;i++) satview[i] = 255;   /* nothing in view yet */
  satview_stale = 0;
  setNextTimestamp(currentTime);
  SetPPS( &PPS );          /* PPS_Init's job: COUNT_NORMAL setPrecision never installs one */
  setPrecision();
}

/* Test hook (conformance only): jump the clock into N seconds of holdover without ticking N
 * seconds, so the precision ladder P3->P2->P1->P0 can be exercised cheaply. Sets last_pps_time
 * and the RTC calibration age to currentTime-secs, then re-evaluates precision — exactly the
 * state the firmware reaches after `secs` real seconds with no PPS. */
void emu_force_holdover(unsigned secs){
  last_pps_time = (uint32_t)currentTime - secs;
  rtc_last_calibration = (uint32_t)currentTime - secs;
  had_pps = 1;
  setPrecision();
}
/* Two-axis holdover: age the PPS and the RTC calibration INDEPENDENTLY. The precision ladder is
 * asymmetric — P3/P2 gate on last_pps_time, but P1 gates on rtc_last_calibration — so this is
 * needed to exercise the P1 branch's distinct dependence (a swapped/broken RTC comparison). */
void emu_force_holdover2(unsigned pps_secs, unsigned cal_secs){
  last_pps_time = (uint32_t)currentTime - pps_secs;
  rtc_last_calibration = (uint32_t)currentTime - cal_secs;
  had_pps = 1;
  setPrecision();
}
/* Active colon animation + the civil/alt references. LST/SOLAR install colonModeAlt so the alt
 * timebases read as "not civil time" at a glance (an intentional honesty feature). */
int emu_colon_mode(void){ return colonMode; }
/* The firmware colon animation is a 200-entry PWM table (buffer_colons_L/R) DMA-cycled at
 * 10 ms/step and resynced to even-second boundaries (colonAnimationSync). Reconstruct the DMA
 * read index from the live sub-second counters + second parity, so the face can drive its colon
 * at the firmware's REAL phase (PPS-disciplined) instead of wall-clock ms. */
int emu_colon_step(void){
  int s = decisec*10 + centisec;               /* 0..99, 10 ms per step */
  if ((uint32_t)currentTime & 1) s += 100;     /* odd second = 2nd half of the 2 s window */
  return s % 200;
}
int emu_colon_civil(void){ return colonModeCivil; }
int emu_colon_alt(void){ return colonModeAlt; }
/* Named mode ids — reference these instead of magic numbers that rot if the enum reorders. */
int emu_MODE_UNIX(void){ return MODE_UNIX; }
int emu_MODE_ISO_ORDINAL(void){ return MODE_ISO_ORDINAL; }
int emu_MODE_ISO_WEEK(void){ return MODE_ISO_WEEK; }
int emu_MODE_WEEKDAY(void){ return MODE_WEEKDAY; }
int emu_MODE_MOON(void){ return MODE_MOON; }
int emu_MODE_GRID(void){ return MODE_GRID; }
int emu_MODE_LATLON(void){ return MODE_LATLON; }
int emu_MODE_SUN(void){ return MODE_SUN; }
int emu_MODE_JULIAN_DATE(void){ return MODE_JULIAN_DATE; }
int emu_MODE_MODIFIED_JD(void){ return MODE_MODIFIED_JD; }

/* $PMTXTS emit capture. The firmware's own emitPPSTimestamp() formats the timing sentence and
 * hands it to CDC_Copy_Transmit — stubbed to a no-op everywhere else. Here we give it a real
 * definition that lands the bytes in RAM, so the emulator can read back the firmware's OWN
 * byte-faithfully-formatted $PMTXTS (same snprintf, same NMEA checksum) for comparison against a
 * bench capture. (Replaces the stubs.js no-op; native_stubs.c's copy is weak so this wins there.) */
static char emu_pmtxts_buf[128];
uint8_t CDC_Copy_Transmit(uint8_t* buf, uint16_t Len){
  uint16_t n = Len < (uint16_t)(sizeof(emu_pmtxts_buf)-1) ? Len : (uint16_t)(sizeof(emu_pmtxts_buf)-1);
  for (uint16_t i = 0; i < n; i++) emu_pmtxts_buf[i] = (char)buf[i];
  emu_pmtxts_buf[n] = 0;
  return 0;  /* USBD_OK */
}
/* Drive one $PMTXTS emit from the values captured at the last emu_pps() edge; return the sentence
 * (with trailing CR/LF), or "" if no record is pending. */
const char* emu_pmtxts_line(void){
  emu_pmtxts_buf[0] = 0;
  pps_ts_enabled = 1;
  hUsbDeviceFS.dev_state = USBD_STATE_CONFIGURED;  /* satisfy emitPPSTimestamp's host-present gate */
  if (pps_record_pending) emitPPSTimestamp();
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
  delayedPostConfigCleanup = 0;
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
