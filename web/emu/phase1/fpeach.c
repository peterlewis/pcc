#include "main.h"
#include <stdint.h>
extern uint32_t __VECTORS_RAM[];
extern void SysTick_CountUp_P0(void), SysTick_CountUp_P3(void), SysTick_CountUp_NoUpdate(void), SysTick_Alt_P0(void);
int emu_store_P0(void){ __VECTORS_RAM[15]=(uint32_t)&SysTick_CountUp_P0; return (int)__VECTORS_RAM[15]; }
int emu_store_P3(void){ __VECTORS_RAM[15]=(uint32_t)&SysTick_CountUp_P3; return (int)__VECTORS_RAM[15]; }
int emu_store_NU(void){ __VECTORS_RAM[15]=(uint32_t)&SysTick_CountUp_NoUpdate; return (int)__VECTORS_RAM[15]; }
int emu_store_Alt(void){ __VECTORS_RAM[15]=(uint32_t)&SysTick_Alt_P0; return (int)__VECTORS_RAM[15]; }
