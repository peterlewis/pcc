#define STM32L476xx
#include "stm32l476xx.h"
/* RAM-backed instances of every peripheral the firmware touches */
SysTick_Type shim_SysTick; SCB_Type shim_SCB;
RTC_TypeDef shim_RTC;
TIM_TypeDef shim_TIM1, shim_TIM2, shim_TIM5, shim_TIM7;
GPIO_TypeDef shim_GPIOA, shim_GPIOB, shim_GPIOC;
ADC_TypeDef shim_ADC1;
ADC_Common_TypeDef shim_ADC123_COMMON;
USART_TypeDef shim_USART1, shim_USART2;
LPTIM_TypeDef shim_LPTIM1;
RCC_TypeDef shim_RCC;
EXTI_TypeDef shim_EXTI;
PWR_TypeDef shim_PWR;
DMA_TypeDef shim_DMA1, shim_DMA2;
