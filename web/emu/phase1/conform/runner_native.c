/* Native twin of the WASM emulator: same main_wrap.c (=> same firmware main.c + shim), driven
 * by a line-oriented event script on stdin, emitting one SNAP line per snapshot. runner_wasm.mjs
 * executes the identical script through the emcc build; a byte-diff of the two traces is the
 * conformance proof (WASM port == native build of the shimmed source). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* emu_* API (defined in main_wrap.c, compiled natively alongside this driver) */
void emu_boot(unsigned);
void emu_boot_cold(unsigned);
void emu_tick(void);
void emu_poll(void);
void emu_pps(void);
void emu_pendsv(void);
int  emu_pendsv_pending(void);
void emu_button1(void);
void emu_button2(void);
void emu_enable_mode(int);
void emu_set_pos(float,float);
void emu_set_adc(unsigned);
void emu_feed_nmea(const char*);
unsigned emu_now(void);
int      emu_mode(void);
unsigned emu_flags(void);
unsigned short emu_bufb(int);
unsigned char  emu_bufc_low(int);
unsigned char  emu_bufc_high(int);
unsigned char* emu_daterow(void);

static void snap(const char* label){
  unsigned char* dr = emu_daterow();
  char date[11];
  for (int i=0;i<10;i++){ unsigned char c=dr[i+1]; date[i]=(c>=32&&c<127)?c:'.'; }
  date[10]=0;
  printf("SNAP %s", label);
  for (int i=0;i<5;i++) printf(" %04x", emu_bufb(i));
  for (int i=0;i<4;i++) printf(" %02x", emu_bufc_low(i));
  for (int i=0;i<4;i++) printf(" %02x", emu_bufc_high(i));
  printf(" m%d f%u t%u \"%s\"\n", emu_mode(), emu_flags(), emu_now(), date);
}

/* one SysTick tick + drain the PendSV the firmware may have requested (as the frame loop does) */
static void tickdrain(void){ emu_tick(); if (emu_pendsv_pending()) emu_pendsv(); }

int main(void){
  setvbuf(stdout, NULL, _IONBF, 0);   /* unbuffered: partial trace survives if the firmware faults */
  char line[512];
  while (fgets(line, sizeof(line), stdin)){
    char* nl = strpbrk(line, "\r\n"); if (nl) *nl = 0;
    if (line[0]==0 || line[0]=='#') continue;
    char* sp = strchr(line, ' ');
    char* arg = sp ? sp+1 : (char*)"";
    if (sp) *sp = 0;

    if      (!strcmp(line,"bootcold")) emu_boot_cold((unsigned)strtoul(arg,0,10));
    else if (!strcmp(line,"boot"))     emu_boot((unsigned)strtoul(arg,0,10));
    else if (!strcmp(line,"enable"))   emu_enable_mode(atoi(arg));
    else if (!strcmp(line,"setadc"))   emu_set_adc((unsigned)strtoul(arg,0,10));
    else if (!strcmp(line,"setpos")){ float la,lo; sscanf(arg,"%f %f",&la,&lo); emu_set_pos(la,lo); }
    else if (!strcmp(line,"tick")){ long n=strtol(arg,0,10); while(n-->0) tickdrain(); }
    else if (!strcmp(line,"pps")){ emu_pps(); if(emu_pendsv_pending()) emu_pendsv(); }
    else if (!strcmp(line,"pendsv")) emu_pendsv();
    else if (!strcmp(line,"poll"))   emu_poll();
    else if (!strcmp(line,"nmea"))   emu_feed_nmea(arg);
    else if (!strcmp(line,"b1")){ emu_button1(); if(emu_pendsv_pending()) emu_pendsv(); }
    else if (!strcmp(line,"b2")){ emu_button2(); if(emu_pendsv_pending()) emu_pendsv(); }
    else if (!strcmp(line,"snap")) snap(arg);
    else fprintf(stderr,"unknown: %s\n", line);
  }
  return 0;
}
