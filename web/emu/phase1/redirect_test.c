#include "stm32_shim.h"
#include <stdio.h>
int main(void){
  SysTick->LOAD = 79999;
  RTC->CALR = 0x100 + 42;
  TIM2->CCR1 = 300;
  printf("SysTick->LOAD=%lu (want 79999)\n", (unsigned long)SysTick->LOAD);
  printf("RTC->CALR=0x%lX (want 0x142)\n", (unsigned long)RTC->CALR);
  printf("TIM2->CCR1=%lu (want 300)\n", (unsigned long)TIM2->CCR1);
  printf("&shim_SysTick=%p  SysTick=%p\n", (void*)&shim_SysTick, (void*)SysTick);
  return 0;
}
