# pccd v0.11.0

config.txt now follows the clock's menu.

Daemons on v0.4.1+ update in place: **DEVICE → UPDATES → UPDATE NOW**.

## New

- **A setting changed with the clock's buttons is written into config.txt on the clock's drive.**
  Until now it was kept only in `SETTINGS.BIN`, where `config.txt` could not show it: the file said
  one thing and the clock ran another. Firmware from November 2026 (clock4 `rollup`) sends its menu
  choices as `config.txt` lines (`$PMCFG`), after every saved change and when asked. pccd asks when
  the port opens and when the drive appears, and gives each key that value in the file:
  - a line for the key is rewritten where it stands; a key with no line gets one at the end;
  - comments, blank lines, line endings and every other key are left exactly as they were;
  - a set the file already satisfies writes nothing;
  - the file as it was is kept in `<history>/config-backups/`;
  - a comment records it: `# synced 2026-11-12 08:45: 2 settings from the clock's menu (pccd)`.

  The clock then reads the new file and drops its stored choices, so the file is the one record.
  Nothing is written for a set that arrives damaged or out of order. `--no-config-sync` turns it
  off. Earlier firmware never sends `$PMCFG`, and nothing changes for it.

## Needs

- **pccd must be able to read and write the clock's drive.** On macOS a pccd running as a
  LaunchDaemon cannot, until `/usr/local/pcc/pccd` is given Full Disk Access (System Settings →
  Privacy & Security → Full Disk Access). `/health` shows `drive_error` while it cannot. Without it
  the clock keeps its menu choices in `SETTINGS.BIN`, as before. The macOS binary is signed with a
  stable Developer ID, so the grant survives later updates.
