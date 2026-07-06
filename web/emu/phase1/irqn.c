#include "main.h"
int emu_idx_systick(void){ return 16 + SysTick_IRQn; }
int emu_idx_pps(void){ return 16 + EXTI9_5_IRQn; }
