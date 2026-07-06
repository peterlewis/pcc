#ifndef SHIM_REDIRECT_H
#define SHIM_REDIRECT_H
/* Redirect CMSIS peripheral pointers from fixed hardware addresses to RAM structs,
   so the firmware's register hot-paths (RTC->BKP31R, SysTick->LOAD, USART->TDR, ...)
   hit WASM linear memory instead of trapping. Applied AFTER the CMSIS/HAL headers. */
extern SysTick_Type shim_SysTick; extern SCB_Type shim_SCB;
extern RTC_TypeDef shim_RTC;
extern TIM_TypeDef shim_TIM1, shim_TIM2, shim_TIM5, shim_TIM7;
extern GPIO_TypeDef shim_GPIOA, shim_GPIOB, shim_GPIOC;
extern ADC_TypeDef shim_ADC1; extern ADC_Common_TypeDef shim_ADC123_COMMON;
extern USART_TypeDef shim_USART1, shim_USART2;
extern LPTIM_TypeDef shim_LPTIM1; extern RCC_TypeDef shim_RCC;
extern EXTI_TypeDef shim_EXTI; extern PWR_TypeDef shim_PWR;
extern DMA_TypeDef shim_DMA1, shim_DMA2;
#undef SysTick
#undef SCB
#undef RTC
#undef TIM1
#undef TIM2
#undef TIM5
#undef TIM7
#undef GPIOA
#undef GPIOB
#undef GPIOC
#undef ADC1
#undef ADC123_COMMON
#undef USART1
#undef USART2
#undef LPTIM1
#undef RCC
#undef EXTI
#undef PWR
#undef DMA1
#undef DMA2
#define SysTick (&shim_SysTick)
#define SCB (&shim_SCB)
#define RTC (&shim_RTC)
#define TIM1 (&shim_TIM1)
#define TIM2 (&shim_TIM2)
#define TIM5 (&shim_TIM5)
#define TIM7 (&shim_TIM7)
#define GPIOA (&shim_GPIOA)
#define GPIOB (&shim_GPIOB)
#define GPIOC (&shim_GPIOC)
#define ADC1 (&shim_ADC1)
#define ADC123_COMMON (&shim_ADC123_COMMON)
#define USART1 (&shim_USART1)
#define USART2 (&shim_USART2)
#define LPTIM1 (&shim_LPTIM1)
#define RCC (&shim_RCC)
#define EXTI (&shim_EXTI)
#define PWR (&shim_PWR)
#define DMA1 (&shim_DMA1)
#define DMA2 (&shim_DMA2)
#endif
