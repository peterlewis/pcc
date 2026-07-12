#!/usr/bin/env bash
# Rebuild the byte-faithful clock4 WASM emulator -> ../clock-fw.mjs
# Builds ENTIRELY FROM SOURCE (no committed .o): compiles the firmware objects
# (astro / zonedetect from the clock4-megabuild submodule) + the emulator shims
# (emu_data / hal_behav / stm32_shim) + main_wrap.c (which #includes the real
# firmware main.c), then links to a SINGLE_FILE ES module. Run from phase1/.
# Needs emscripten (emcc) on PATH and the clock4-megabuild submodule checked out.
set -euo pipefail
cd "$(dirname "$0")"

# Firmware source. Honor an explicit FW= override (feature branches / testing — point it at a
# .../mk4-time dir); else prefer the pinned submodule (web/emu/firmware, used by CI); else the
# local clock4-megabuild dev worktree. The submodule + worktree paths give byte-identical WASM.
if   [ -n "${FW:-}" ] && [ -d "$FW" ];            then :   # explicit override
elif [ -d ../firmware/mk4-time ];                 then FW=../firmware/mk4-time
elif [ -d ../../../clock4-megabuild/mk4-time ];   then FW=../../../clock4-megabuild/mk4-time
else echo "ERROR: firmware source not found — run: git submodule update --init web/emu/firmware" >&2; exit 1; fi
echo "firmware source: $FW"
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
"_emu_button1","_emu_button2","_emu_enable_mode","_emu_set_pos","_emu_set_adc","_emu_set_dac",
"_emu_daterow","_emu_bufb","_emu_bufc_low","_emu_bufc_high","_emu_MODE_LST","_emu_MODE_SOLAR",
"_emu_feed_nmea","_emu_pps","_emu_pendsv","_emu_pendsv_pending","_emu_force_holdover","_emu_force_holdover2",
"_emu_set_vbus","_emu_config_line","_emu_set_tz_offset","_emu_tz_offset",
"_emu_colon_mode","_emu_colon_civil","_emu_colon_alt","_emu_colon_step",
"_emu_MODE_UNIX","_emu_MODE_ISO_ORDINAL","_emu_MODE_ISO_WEEK","_emu_MODE_WEEKDAY",
"_emu_MODE_MOON","_emu_MODE_GRID","_emu_MODE_LATLON","_emu_MODE_SUN",
"_emu_MODE_JULIAN_DATE","_emu_MODE_MODIFIED_JD","_emu_pmtxts_line",
"_emu_register_file","_emu_load_zone","_emu_offset_at","_emu_set_systick","_emu_zone_from_pos",
"_emu_flags","_emu_data_valid","_emu_had_pps","_emu_since_pps","_emu_satcount","_emu_digit_fade","_emu_holdover_u_us","_emu_tc_probe","_emu_config_done","_emu_tc_fill","_emu_tc_refit","_emu_cuckoo_active","_emu_cuckoo_level","_emu_cuckoo_set","_emu_MODE_CUCKOO_SHOWCASE","_emu_adev_reset","_emu_adev_push","_emu_adev_push_dwt","_emu_adev_valid","_emu_adev_reduce","_emu_adev_sigma","_emu_adev_noctave","_emu_MODE_ADEV","_emu_adev_line","_emu_render_mode","_emu_MODE_STAR","_emu_star_line","_emu_lst","_emu_set_pos","_emu_star_count","_emu_star_ra","_emu_star_dec","_emu_star_pmra","_emu_star_pmdec","_emu_star_ra_now","_emu_star_dec_now","_emu_star_refresh","_emu_star_from_card","_emu_load_stars","_emu_star_max_mag","_emu_star_name","_emu_menu_event","_emu_menu_tick","_emu_menu_layer","_emu_menu_idx","_emu_menu_section","_emu_menu_modecount","_emu_tc_learn","_emu_tc_apply","_emu_set_tc","_emu_seg_balance","_emu_colon_balance","_emu_set_balance","_emu_colon_scale","_emu_set_colon_anchors","_emu_colon_mode","_emu_colon_preview","_emu_ee_reset","_emu_ee_load","_emu_ee_commit","_emu_ee_apply","_emu_ovr_clear","_emu_ovr_valid","_emu_set_mtime","_emu_cfg_defined","_emu_brightness","_emu_set_brightness","_emu_ee_peek","_emu_ee_poke","_emu_settings_attach","_emu_settings_host_write","_emu_ee_backing","_emu_ee_sfile_state","_emu_ee_next","_emu_menu_dirty","_emu_menu_val","_emu_menu_reset","_emu_menu_reset_pending","_emu_menu_reset_step","_emu_set_uart_ready","_emu_set_pps","_emu_ee2_reset","_emu_ee2_load","_emu_ee2_commit","_emu_ee2_peek","_emu_ee2_poke","_emu_tc_persist_set","_emu_tc_seed_flag","_emu_cfg_tc_defined","_emu_tc_forget","_emu_tc_model_dirty","_emu_tc_model_check","_emu_tc_model_supported","_emu_tc_set_model","_emu_tc_clear_model","_emu_tc_seed_boot","_emu_tc2_probe","_malloc","_free"]'

CFLAGS=("${INCS[@]}" "${DEFS[@]}" -O2 -Wno-implicit-function-declaration)

# The sidereal alt_* staging has no header to __has_include on; probe the firmware source so a
# lean branch (no LST/solar) still builds — main_wrap.c compiles out alt_update()/MODE_LST then.
if ! grep -q "alt_update" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_ALT=0)
fi
# Deferred config cleanup (delayedPostConfigCleanup) arrived with the hardening branch; older/leaner
# branches run postConfigCleanup straight from the ISR and have no flag to acknowledge.
if grep -q "delayedPostConfigCleanup" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_DELAYED_CLEANUP=1)
fi
# Cuckoo display animations (CUCKOO_SPEC.md) live on the cuckoo branch.
if grep -q "cuckoo_poll" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_CUCKOO=1)
fi
# Self-learning tempcomp + significance fade (PR #9 / rollup); stock master lacks them.
if grep -q "significance_fade" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_TEMPCOMP=1)
fi
# Per-segment brightness balance lives on the seg-balance branch; rollup/stock lack it.
if grep -q "segbal_poll" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_SEGBAL=1)
fi

if grep -q "adev_push_dwt" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_ADEV=1)
fi

if grep -q "star_update" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_STAR=1)
fi

# Auto-persist the learned tempcomp model to flash (the ee2 store). Lives above the menu on rollup;
# a branch with tempcomp but no persistence (menu PR, PR #9) lacks tc2/ee2 — compile the hooks out.
if grep -q "ee2_init_base" "$FW/Core/Src/main.c"; then
  CFLAGS+=(-DEMU_HAS_TC_PERSIST=1)
fi

echo "[1/3] compile firmware + shim objects from source"
# astro.c only exists on the astro-pack/rollup branches; building against a leaner branch
# (e.g. the tempcomp PR branch) just skips it — main.c there makes no astro calls.
ASTRO_O=""
if [ -f "$FW/Core/Src/astro.c" ]; then
  emcc -c "$FW/Core/Src/astro.c"    -o astro.o      "${CFLAGS[@]}"
  ASTRO_O=astro.o
fi
emcc -c "$FW/Core/Src/zonedetect.c" -o zonedetect.o "${CFLAGS[@]}"
emcc -c emu_data.c                  -o emu_data.o   "${CFLAGS[@]}"
emcc -c hal_behav.c                 -o hal_behav.o  "${CFLAGS[@]}"

echo "[2/3] compile main_wrap.c -> main_redir.o"
emcc -c main_wrap.c -o main_redir.o "${CFLAGS[@]}"

echo "[3/3] link -> ../clock-fw.mjs"
emcc main_redir.o $ASTRO_O zonedetect.o stm32_shim.c emu_data.o hal_behav.o \
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
