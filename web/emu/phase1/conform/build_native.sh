#!/usr/bin/env bash
# Native twin of the WASM emulator: same firmware C + same shim, compiled with clang for the host.
# Produces ./conform_native (reads an event script on stdin, emits SNAP trace lines).
set -euo pipefail
cd "$(dirname "$0")"

P1=..                       # phase1/
FW=../../../../clock4-megabuild/mk4-time
INCS=(
  -Inative-shim             # shadows stm32l4xx_hal_conf.h (drops FLASH module) — before Core/Inc
  -I"$P1"                   # shim_redirect.h, stubs live here
  -I"$P1/cmsis-shim"        # shadows CMSIS asm intrinsics — must precede real CMSIS/Include
  -I"$FW/Core/Src" -I"$FW/Core/Inc"
  -I"$FW/Drivers/STM32L4xx_HAL_Driver/Inc"
  -I"$FW/Drivers/CMSIS/Device/ST/STM32L4xx/Include"
  -I"$FW/Drivers/CMSIS/Include"
  -I"$FW/FATFS/App" -I"$FW/FATFS/Target"
  -I"$FW/Middlewares/Third_Party/FatFs/src"
  -I"$FW/USB_DEVICE/App" -I"$FW/USB_DEVICE/Target"
  -I"$FW/Middlewares/ST/STM32_USB_Device_Library/Core/Inc"
  -I"$FW/Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc"
)
DEFS=(-DSTM32L476xx -DUSE_HAL_DRIVER -DUSE_FULL_LL_DRIVER -DEMU_NATIVE64)
CFLAGS=(-O2 -Wno-implicit-function-declaration -Wno-format -std=gnu11)

echo "[native] compiling firmware + shim"
clang -c "$P1/main_wrap.c"    -o main_native.o   "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c "$FW/Core/Src/astro.c"      -o astro_native.o "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c "$FW/Core/Src/zonedetect.c" -o zone_native.o  "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c "$P1/stm32_shim.c"   -o shim_native.o    "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c "$P1/emu_data.c"     -o data_native.o    "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c "$P1/hal_behav.c"    -o hal_native.o     "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"
clang -c native_stubs.c       -o stubs_native.o   "${CFLAGS[@]}" -Wno-strict-prototypes
clang -c runner_native.c      -o runner_native.o  "${INCS[@]}" "${DEFS[@]}" "${CFLAGS[@]}"

echo "[native] linking -> conform_native"
# native_stubs.o mirrors the WASM JS no-op set; dynamic_lookup is the safety net for anything
# reachable that isn't in either (a fault then names exactly what to add).
clang main_native.o astro_native.o zone_native.o shim_native.o data_native.o hal_native.o \
      stubs_native.o runner_native.o -o conform_native -Wl,-undefined,dynamic_lookup

echo "OK -> conform_native"
