# pccd v0.10.1

A mounted clock drive that the daemon cannot read is now reported, not silent.

Daemons on v0.4.1+ update in place: **DEVICE → UPDATES → UPDATE NOW**.

## Fixed

- On macOS, a pccd running as a LaunchDaemon sees `/Volumes/CLOCK` mounted but cannot read it: macOS
  does not let launchd jobs read removable volumes. It said nothing, so `/health` reported
  `drive: null` and the app said the drive was not mounted. The daemon now logs the reason once,
  `/health` carries `drive_error`, and the app shows `MOUNTED · READ BY THE APP` and reads the drive
  itself (READ CLOCK DRIVE). Giving `/usr/local/pcc/pccd` Full Disk Access is optional, for anyone
  who wants pccd to serve the drive.

## Changed

- The release workflow signs the macOS binary with a Developer ID when the repo has a signing
  certificate set, and ships it ad-hoc signed otherwise.
