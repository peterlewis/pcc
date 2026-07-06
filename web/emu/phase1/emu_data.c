#include <stdint.h>
#include "usb_device.h"          /* USBD_HandleTypeDef */
uint32_t __VECTORS_RAM[128];
uint32_t __VECTORS_FLASH[128];
uint32_t _app_crc[1] = {0};
volatile uint32_t uwTick = 0;
USBD_HandleTypeDef hUsbDeviceFS; /* USB device handle (no real USB in emu) */
volatile uint32_t qspi_write_time = 0, qspi_usb_read_time = 0;
