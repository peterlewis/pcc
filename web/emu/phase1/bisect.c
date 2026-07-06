#include "main.h"
#include <stdint.h>
extern uint8_t countMode, displayMode;
void emu_set_cm(int c){ countMode=(uint8_t)c; }
void emu_call_setprec(void){ setPrecision(); }
