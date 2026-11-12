MEMORY { ROM (rx) : ORIGIN = 0x00000000, LENGTH = 1M   RAM (rwx) : ORIGIN = 0x20000000, LENGTH = 1M }
ENTRY(Reset_Handler)
SECTIONS {
  .text : { KEEP(*(.vectors)) *(.text*) *(.rodata*) . = ALIGN(4); } > ROM
  .ARM.exidx : { *(.ARM.exidx*) } > ROM
  _sidata = LOADADDR(.data);
  .data : { _sdata = .; *(.data*) . = ALIGN(4); _edata = .; } > RAM AT > ROM
  .bss : { _sbss = .; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; } > RAM
  _end = .; end = .;
  _estack = ORIGIN(RAM) + LENGTH(RAM);
}
