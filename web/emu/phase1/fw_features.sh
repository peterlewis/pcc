# fw_features.sh: which optional features this firmware has, as -DEMU_HAS_* flags.
# Sourced by build.sh (the WASM emulator) and conform/build_native.sh (its native twin), so the two
# builds of main_wrap.c always get the same flags. Set FW to the firmware's mk4-time directory first.
# Result: the FW_FEATURES array.
FW_FEATURES=()

# Does this firmware have a feature? main.c is split into sections under Core/Src/main_parts/ (still
# one translation unit, included by main.c), so a probe looks in all of them. A branch from before
# the split has only main.c, and the unmatched glob is then just a file grep cannot open (-s).
fw_has(){ grep -qs "$1" "$FW/Core/Src/main.c" "$FW"/Core/Src/main_parts/*.h; }

# The sidereal alt_* staging has no header to __has_include on; probe the firmware source so a
# lean branch (no LST/solar) still builds — main_wrap.c compiles out alt_update()/MODE_LST then.
if ! fw_has "alt_update"; then
  FW_FEATURES+=(-DEMU_HAS_ALT=0)
fi
# Deferred config cleanup (delayedPostConfigCleanup) arrived with the hardening branch; older/leaner
# branches run postConfigCleanup straight from the ISR and have no flag to acknowledge.
if fw_has "delayedPostConfigCleanup"; then
  FW_FEATURES+=(-DEMU_HAS_DELAYED_CLEANUP=1)
fi
# The filtered sub-degree die temperature the holdover steering works from.
if fw_has "die_temp_filter"; then
  FW_FEATURES+=(-DEMU_HAS_TEMP_F=1)
fi
# The learned wander saved in the tempcomp store's record.
if fw_has "fw_restore_from_flash"; then
  FW_FEATURES+=(-DEMU_HAS_FW_PERSIST=1)
fi
# The significance fade's bound built from the measured offset and the learned wander.
if fw_has "fade_wander_var"; then
  FW_FEATURES+=(-DEMU_HAS_FADE_WANDER=1)
fi
# config.txt re-derivation: a key removed from the file goes back to its default on the next load.
if fw_has "cfg_defaults"; then
  FW_FEATURES+=(-DEMU_HAS_CFG_REDERIVE=1)
fi
# Frequency hold (freq_hold = on): steer out the measured oscillator offset in holdover.
if fw_has "fh_learn"; then
  FW_FEATURES+=(-DEMU_HAS_FREQ_HOLD=1)
fi
# The opt-in independent watchdog (watchdog = on).
if fw_has "wdt_poll"; then
  FW_FEATURES+=(-DEMU_HAS_WDT=1)
fi
# QSPI read-fault injection for the settings store arrived with the read-fault fix.
if fw_has "ee_sfile_rdfault"; then
  FW_FEATURES+=(-DEMU_HAS_EE_RDFAULT=1)
fi
# Cuckoo display animations (CUCKOO_SPEC.md) live on the cuckoo branch.
if fw_has "cuckoo_poll"; then
  FW_FEATURES+=(-DEMU_HAS_CUCKOO=1)
fi
# Self-learning tempcomp + significance fade (PR #9 / rollup); stock master lacks them.
if fw_has "significance_fade"; then
  FW_FEATURES+=(-DEMU_HAS_TEMPCOMP=1)
fi
# Per-segment brightness balance lives on the seg-balance branch; rollup/stock lack it.
if fw_has "segbal_poll"; then
  FW_FEATURES+=(-DEMU_HAS_SEGBAL=1)
fi

if fw_has "adev_push_dwt"; then
  FW_FEATURES+=(-DEMU_HAS_ADEV=1)
fi

if fw_has "star_update"; then
  FW_FEATURES+=(-DEMU_HAS_STAR=1)
fi

# The $PMBRIT brightness sentence (brightness_report) arrives with the segment-balance tier.
if fw_has "brightness_report_poll"; then
  FW_FEATURES+=(-DEMU_HAS_BRIT=1)
fi

# Auto-persist the learned tempcomp model to flash (the ee2 store). Lives above the menu on rollup;
# a branch with tempcomp but no persistence (menu PR, PR #9) lacks tc2/ee2 — compile the hooks out.
if fw_has "ee2_init_base"; then
  FW_FEATURES+=(-DEMU_HAS_TC_PERSIST=1)
fi
