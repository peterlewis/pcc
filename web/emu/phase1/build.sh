#!/usr/bin/env bash
# Rebuild the byte-faithful clock4 WASM emulator -> ../clock-fw.{mjs,wasm}
# Compiles main_wrap.c (which #includes the real firmware main.c) + shims, links with
# prebuilt astro.o / zonedetect.o. Run from phase1/.
set -euo pipefail
cd "$(dirname "$0")"

FW=../../../clock4-megabuild/mk4-time
INCS=(
  -I.                        # shim_redirect.h
  -Icmsis-shim               # shadows CMSIS asm intrinsics — must precede real CMSIS/Include
  -I"$FW/Core/Src"           # main.c (#included by main_wrap.c) + astro.c
  -I"$FW/Core/Inc"
  -I"$FW/Drivers/STM32L4xx_HAL_Driver/Inc"
  -I"$FW/Drivers/CMSIS/Device/ST/STM32L4xx/Include"
  -I"$FW/Drivers/CMSIS/Include"
  -I"$FW/FATFS/App" -I"$FW/FATFS/Target"
  -I"$FW/Middlewares/Third_Party/FatFs/src"
  -I"$FW/USB_DEVICE/App" -I"$FW/USB_DEVICE/Target"
  -I"$FW/Middlewares/ST/STM32_USB_Device_Library/Core/Inc"
  -I"$FW/Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Inc"
)
DEFS=(-DSTM32L476xx -DUSE_HAL_DRIVER -DUSE_FULL_LL_DRIVER)

EXPORTS='["_emu_boot","_emu_boot_cold","_emu_tick","_emu_poll","_emu_now","_emu_mode",
"_emu_button1","_emu_button2","_emu_enable_mode","_emu_set_pos","_emu_set_adc",
"_emu_daterow","_emu_bufb","_emu_bufc_low","_emu_bufc_high","_emu_MODE_LST","_emu_MODE_SOLAR",
"_emu_feed_nmea","_emu_pps","_emu_pendsv","_emu_pendsv_pending","_emu_force_holdover","_emu_force_holdover2",
"_emu_set_vbus","_emu_config_line","_emu_set_tz_offset","_emu_tz_offset",
"_emu_colon_mode","_emu_colon_civil","_emu_colon_alt","_emu_colon_step",
"_emu_MODE_UNIX","_emu_MODE_ISO_ORDINAL","_emu_MODE_ISO_WEEK","_emu_MODE_WEEKDAY",
"_emu_MODE_MOON","_emu_MODE_GRID","_emu_MODE_LATLON","_emu_MODE_SUN",
"_emu_MODE_JULIAN_DATE","_emu_MODE_MODIFIED_JD","_emu_pmtxts_line",
"_emu_register_file","_emu_load_zone","_emu_offset_at","_emu_set_systick","_emu_zone_from_pos",
"_emu_flags","_emu_data_valid","_emu_had_pps","_emu_since_pps","_emu_satcount","_malloc","_free"]'

echo "[1/2] compile main_wrap.c -> main_redir.o"
emcc -c main_wrap.c -o main_redir.o "${INCS[@]}" "${DEFS[@]}" -O2 \
  -Wno-implicit-function-declaration

echo "[2/2] link -> ../clock-fw.mjs"
emcc main_redir.o astro.o zonedetect.o stm32_shim.c emu_data.o hal_behav.o \
  "${INCS[@]}" "${DEFS[@]}" -O2 \
  --js-library stubs.js \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_RUNTIME_METHODS='["ccall","cwrap","HEAPU8"]' \
  -sEXPORTED_FUNCTIONS="$EXPORTS" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=node,web \
  -sALLOW_MEMORY_GROWTH=1 \
  -sSINGLE_FILE=1 \
  -o ../clock-fw.mjs

echo "OK -> ../clock-fw.mjs  ($(date +%H:%M:%S))"
