#include "main.h"
extern void SysTick_Alt_P0(void);
extern uint32_t __VECTORS_RAM[];
/* replicate exactly what SetSysTick does */
int emu_fptest(void){
  __VECTORS_RAM[15] = (uint32_t)&SysTick_Alt_P0;     /* the store setPrecision does */
  return (int)__VECTORS_RAM[15];                      /* read back the stored index */
}
