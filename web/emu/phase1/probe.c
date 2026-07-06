#define STM32L476xx
#include "stm32l476xx.h"
int probe_systick_load(void){ return (int)(SysTick->LOAD); }
int probe_rtc_calr(void){ return (int)(RTC->CALR); }
