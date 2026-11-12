// reent_test.c - the firmware's own C library (newlib-nano, same multilib), bare metal on a QEMU
// Cortex-M4: the main loop formats floats the way the dump lines do (tc_dump, $PMADEV), while a real
// SysTick lands inside the print at every offset and its handler does what a firmware handler does.
//   SHARED   the handler formats a float through the same context   -> the old sendDate
//   PRIVATE  the handler swaps in its own context first             -> the fixed sendDate
//   ATOF     the handler parses GPS minutes with atof (decodeRMC), shared context
// Built and run by reent_qemu_check.sh.
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <reent.h>
#include <malloc.h>
#include <errno.h>
#define SYST_CSR (*(volatile uint32_t*)0xE000E010)
#define SYST_RVR (*(volatile uint32_t*)0xE000E014)
#define SYST_CVR (*(volatile uint32_t*)0xE000E018)
#define CPACR    (*(volatile uint32_t*)0xE000ED88)
extern uint32_t _estack,_sidata,_sdata,_edata,_sbss,_ebss; extern char _end;
int main(void);
static int sh(int op, const void *arg){ register int r0 __asm__("r0")=op; register const void *r1 __asm__("r1")=arg; __asm__ volatile("bkpt 0xAB":"+r"(r0):"r"(r1):"memory"); return r0; }
static void out(const char *s){ sh(0x04, s); }
void Reset_Handler(void){
  uint32_t *s=&_sidata,*d=&_sdata; while(d<&_edata)*d++=*s++; for(d=&_sbss;d<&_ebss;)*d++=0;
  CPACR |= (0xFu<<20); __asm__ volatile("dsb\nisb");
  main(); sh(0x18,(void*)0x20026); for(;;);
}
void Fault(void){ out("FAULT\n"); sh(0x18,(void*)0x20026); for(;;); }
void SysTick_Handler(void);
__attribute__((section(".vectors"),used)) void (*const vectors[16])(void) = {
  (void(*)(void))&_estack, Reset_Handler, Fault, Fault, Fault, Fault, Fault, 0,0,0,0, Fault, Fault, 0, Fault, SysTick_Handler };
void *_sbrk(int n){ static char *h; if(!h) h=&_end; char *p=h; h+=n; return p; }
// the firmware's malloc lock, verbatim in effect: mask interrupts for one heap operation
static uint32_t lk_pm, lk_depth;
void __malloc_lock(struct _reent *r){ (void)r; uint32_t pm; __asm__ volatile("mrs %0, primask\ncpsid i":"=r"(pm)); if(lk_depth++==0) lk_pm=pm; }
void __malloc_unlock(struct _reent *r){ (void)r; if(--lk_depth==0 && !lk_pm) __asm__ volatile("cpsie i"); }

static struct _reent isr_reent = _REENT_INIT(isr_reent);
static volatile int mode, isr_ran;      // 0 SHARED, 1 PRIVATE, 2 ATOF
static volatile double parsed;
static char isr_out[24];
void SysTick_Handler(void){
  SYST_CSR = 0;                                   // one shot
  if (mode == 2) {
    parsed = atof("23.45678");                               // decodeRMC: minutes of latitude
    strcpy(isr_out, parsed > 23.4567 && parsed < 23.4569 ? "0.25" : "bad");
  } else {
    struct _reent *saved = _impure_ptr;
    if (mode == 1) _impure_ptr = &isr_reent;                 // the fix: SD_CONTEXT_ENTER
    snprintf(isr_out, sizeof isr_out, "%.2f", 0.25);         // the date row's "HSE -0.25"
    _impure_ptr = saved;                                     // SD_CONTEXT_LEAVE
  }
  isr_ran = 1;
}
static int run(int m, int *fired, int *bad_main, int *bad_isr, char *sample){
  static const struct { const char *fmt; double v; const char *want; } T[] = {
    { "%.5f", 18.68123,  "18.68123" },                         // tc_dump: tc_lse_a
    { "%.6f", -0.034217, "-0.034217" },                        // tc_dump: curvature
    { "%.2e", 3.21e-11,  "3.21e-11" },                         // $PMADEV sigma
  };
  char buf[32]; int n=0; mode=m;
  for (unsigned t=0;t<3;t++)
    for (uint32_t d=1; d<=260; d++)                            // SysTick reload: 40 instructions a step
      for (volatile uint32_t ph=0; ph<8; ph++){                // sub-step phase
        isr_ran=0; isr_out[0]=0;
        for (volatile uint32_t k=0;k<ph*3;k++){}
        SYST_RVR=d; SYST_CVR=0; SYST_CSR=7;
        snprintf(buf, sizeof buf, T[t].fmt, T[t].v);
        SYST_CSR=0; n++;
        if (isr_ran){ (*fired)++;
          if (strcmp(isr_out,"0.25")) (*bad_isr)++;
          if (strcmp(buf,T[t].want)){ if(!*bad_main){ strcpy(sample,"wanted "); strcat(sample,T[t].want); strcat(sample,", got "); strcat(sample,buf);} (*bad_main)++; }
        } else if (strcmp(buf,T[t].want)) { out("UNINTERRUPTED MISMATCH\n"); }
      }
  return n;
}
int main(void){
  char line[200], sample[80];
  static const char *const name[3] = { "SHARED", "PRIVATE", "ATOF" };
  for (int m=0; m<3; m++){
    int fired=0,bm=0,bi=0; sample[0]=0;
    int n=run(m,&fired,&bm,&bi,sample);
    snprintf(line,sizeof line,"RESULT %s prints=%d interrupted=%d main_wrong=%d handler_wrong=%d%s%s\n",
             name[m],n,fired,bm,bi, sample[0]?" sample: ":"", sample);
    out(line);
  }
  return 0;
}
