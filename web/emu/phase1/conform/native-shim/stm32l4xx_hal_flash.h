/* Native-only shadow of the HAL FLASH header. The real header pulls in
 * stm32l4xx_hal_flash_ramfunc.h, whose prototypes carry
 * __attribute__((section(".RamFunc"))) — valid on wasm/embedded, rejected by Mach-O.
 * Neutralise __RAM_FUNC to empty (host code is never placed in RAM), then defer to the real
 * header via include_next. Behaviour-neutral: the emu paths never call FLASH HAL. */
#undef  __RAM_FUNC
#define __RAM_FUNC
#include_next "stm32l4xx_hal_flash.h"
