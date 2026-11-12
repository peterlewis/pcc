#!/usr/bin/env bash
# reent_qemu_check.sh - a manual check (not run in CI: it needs the ARM toolchain and QEMU).
#
# Why sendDate has its own C-library context. newlib keeps the scratch state of float conversion in
# one structure reached through the global _impure_ptr. A handler that formats a float while the main
# loop is in the middle of formatting one frees and reuses the buffer the main loop is still reading:
# the main loop's line goes out with wrong digits. No fault, nothing to see.
#
# This builds reent_test.c against the SAME libc_nano the firmware links (same -mcpu/-mfpu/-mfloat-abi
# multilib), runs it bare metal on QEMU's Cortex-M4 board with a real SysTick, and requires:
#   SHARED   context: the corruption reproduces (else this test has stopped testing anything)
#   PRIVATE  context: no wrong output at all - the firmware's fix
#   ATOF     the GPS handler's atof, shared context: no wrong output (it needs no fix)
# Run: bash reent_qemu_check.sh     (ARM_TC=/path/to/toolchain/bin to override the compiler search)
set -euo pipefail
cd "$(dirname "$0")"

GCC=""
if [ -n "${ARM_TC:-}" ] && [ -x "$ARM_TC/arm-none-eabi-gcc" ]; then GCC="$ARM_TC/arm-none-eabi-gcc"
elif command -v arm-none-eabi-gcc >/dev/null 2>&1; then GCC="$(command -v arm-none-eabi-gcc)"
else GCC="$(ls -d /Applications/STM32CubeIDE.app/Contents/Eclipse/plugins/com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.*/tools/bin/arm-none-eabi-gcc 2>/dev/null | tail -1 || true)"; fi
QEMU="$(command -v qemu-system-arm || true)"
if [ -z "$GCC" ] || [ -z "$QEMU" ]; then
  echo "CANNOT RUN: needs arm-none-eabi-gcc (found: ${GCC:-none}) and qemu-system-arm (found: ${QEMU:-none})"; exit 2
fi

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
"$GCC" reent_test.c -o "$T/reent_test.elf" -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard -mthumb -O1 \
  -ffunction-sections -fdata-sections --specs=nano.specs --specs=nosys.specs -nostartfiles -T link.ld \
  -Wl,--gc-sections -u _printf_float -Wl,--start-group -lc -lm -Wl,--end-group >"$T/link.log" 2>&1 \
  || { cat "$T/link.log"; echo "BUILD FAILED"; exit 1; }

# -icount makes the SysTick land at a deterministic instruction, so every run sweeps the same offsets.
OUT="$(perl -e 'alarm 300; exec @ARGV' "$QEMU" -machine mps2-an386 -cpu cortex-m4 -nographic \
  -semihosting-config enable=on,target=native -icount shift=0 -kernel "$T/reent_test.elf" 2>&1 | grep '^RESULT' || true)"
echo "$OUT"

field(){ echo "$OUT" | awk -v m="$1" -v k="$2" '$2==m{for(i=3;i<=NF;i++){split($i,a,"=");if(a[1]==k)print a[2]}}'; }
fail=0
chk(){ if [ "$2" = "1" ]; then echo "PASS  $1"; else echo "FAIL  $1"; fail=1; fi; }
num(){ [ -n "$1" ] && [ "$1" -eq "$1" ] 2>/dev/null; }
for m in SHARED PRIVATE ATOF; do num "$(field $m interrupted)" || { echo "FAIL  no result for $m"; exit 1; }; done
chk "the timer really lands inside the prints ($(field SHARED interrupted) of $(field SHARED prints))" "$([ "$(field SHARED interrupted)" -gt 500 ] && echo 1 || echo 0)"
chk "SHARED context: the main loop's output is corrupted ($(field SHARED main_wrong) wrong)" "$([ "$(field SHARED main_wrong)" -gt 0 ] && echo 1 || echo 0)"
chk "PRIVATE context: no main-loop output is wrong" "$([ "$(field PRIVATE main_wrong)" -eq 0 ] && echo 1 || echo 0)"
chk "PRIVATE context: no handler output is wrong" "$([ "$(field PRIVATE handler_wrong)" -eq 0 ] && echo 1 || echo 0)"
chk "PRIVATE context: just as many prints were interrupted ($(field PRIVATE interrupted))" "$([ "$(field PRIVATE interrupted)" -eq "$(field SHARED interrupted)" ] && echo 1 || echo 0)"
chk "ATOF in the handler, shared context: nothing is wrong" "$([ "$(field ATOF main_wrong)" -eq 0 ] && [ "$(field ATOF handler_wrong)" -eq 0 ] && echo 1 || echo 0)"
[ "$fail" = 0 ] && echo && echo "ALL PASS" || { echo; echo "FAIL"; }
exit $fail
