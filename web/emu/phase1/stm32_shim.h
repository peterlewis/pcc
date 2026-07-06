#ifndef STM32_SHIM_H
#define STM32_SHIM_H
#define STM32L476xx
#include "stm32l476xx.h"     /* real register struct TYPES + bit definitions */

/* Redirect the memory-mapped peripheral pointers from fixed hardware addresses
   to allocated RAM, so firmware register reads/writes hit WASM linear memory. */
extern SysTick_Type   shim_SysTick;
extern RTC_TypeDef    shim_RTC;
extern TIM_TypeDef    shim_TIM2, shim_TIM1, shim_TIM5, shim_TIM7;
extern GPIO_TypeDef   shim_GPIOA, shim_GPIOB, shim_GPIOC;
extern ADC_TypeDef    shim_ADC1;
extern USART_TypeDef  shim_USART1, shim_USART2;
extern SCB_Type       shim_SCB;
extern LPTIM_TypeDef  shim_LPTIM1;

#undef SysTick
#undef RTC
#undef TIM2
#undef GPIOB
#undef SCB
#define SysTick (&shim_SysTick)
#define RTC     (&shim_RTC)
#define TIM2    (&shim_TIM2)
#define GPIOB   (&shim_GPIOB)
#define SCB     (&shim_SCB)
#endif
