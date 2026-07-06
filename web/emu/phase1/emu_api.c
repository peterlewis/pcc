#include <stdint.h>
#include <time.h>
#include "main.h"                      /* MODE_LST, MODE_SOLAR, COUNT_ALT, cLut */
extern time_t currentTime;
extern uint8_t displayMode, countMode, colonMode;
extern float latitude, longitude;
extern uint8_t uart2_tx_buffer[32];
extern struct { uint8_t c; uint16_t b[5]; } next7seg;
extern void setNextTimestamp(time_t nextTime);
extern void alt_update(void);          /* real firmware: seeds/stages the alternate time-row */

/* civil-date path (proven at first light) */
void      emu_set_time(unsigned int t){ currentTime = (time_t)t; }
void      emu_set_mode(int m){ displayMode = (uint8_t)m; }
void      emu_prep(void){ setNextTimestamp(currentTime); }
void      emu_send_date(void){ sendDate(1); }
uint8_t*  emu_daterow(void){ return &uart2_tx_buffer[0]; }
uint8_t   emu_seg_c(void){ return next7seg.c; }
uint16_t  emu_seg_b(int i){ return next7seg.b[i]; }

/* alternate timebase (sidereal / solar) path */
int       emu_MODE_LST(void){ return MODE_LST; }
int       emu_MODE_SOLAR(void){ return MODE_SOLAR; }
void      emu_set_pos(float lat, float lon){ latitude = lat; longitude = lon; }
void      emu_enter_alt(int mode){ displayMode = (uint8_t)mode; countMode = COUNT_HIDDEN; }
void      emu_alt_update(void){ alt_update(); }   /* runs the REAL firmware alt path -> next7seg */

/* ---- live ticking ---- */
#include <stdbool.h>
extern uint32_t last_pps_time; extern _Bool had_pps;
extern uint32_t __VECTORS_RAM[];
extern struct { unsigned short fdate, ftime; uint32_t tolerance_1ms, tolerance_10ms, tolerance_100ms; } config; /* prefix-compatible */
extern void setPrecision(void);
/* boot a GPS-locked civil clock at time t */
void emu_boot(unsigned int t){
  currentTime = (time_t)t; last_pps_time = (uint32_t)t; had_pps = 1;
  displayMode = 0 /*MODE_ISO8601_STD*/; countMode = 0 /*COUNT_NORMAL*/;
  config.tolerance_1ms = 1000; config.tolerance_10ms = 10000; config.tolerance_100ms = 100000;
  setNextTimestamp(currentTime);
  setPrecision();            /* installs the P3 handler into __VECTORS_RAM */
}
/* one 1 kHz SysTick: dispatch through the installed vector, exactly like hardware would */
void emu_tick(void){
  void (*h)(void) = (void(*)(void)) __VECTORS_RAM[ 16 + SysTick_IRQn ];
  if (h) h();
}
unsigned int emu_now(void){ return (unsigned int)currentTime; }

uint16_t emu_bufb(int i){ return buffer_b[i]; }         /* buffer_b/buffer_c from main.h */
uint8_t  emu_bufc_low(int i){ return buffer_c[i].low; }
uint8_t  emu_bufc_high(int i){ return buffer_c[i].high; }
