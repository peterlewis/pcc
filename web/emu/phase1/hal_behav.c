#include <stdint.h>
extern volatile uint32_t uwTick;
void HAL_IncTick(void){ uwTick++; }
uint32_t HAL_GetTick(void){ return uwTick; }
void HAL_Delay(uint32_t ms){ (void)ms; }
