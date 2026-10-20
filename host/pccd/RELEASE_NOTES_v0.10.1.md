# pccd v0.10.1

A mounted clock drive that the daemon cannot read is now reported, not silent.

Daemons on v0.4.1+ update in place: **DEVICE → UPDATES → UPDATE NOW**.

## Fixed

- On macOS, a pccd running as a launchd daemon could see `/Volumes/CLOCK` mounted yet fail to read it,
  and said nothing: `/health` reported `drive: null` and the app said the drive was not mounted. The
  daemon now logs why (`/Volumes/CLOCK is mounted but this process cannot read it: <reason>`), with the
  remedy for each case (Full Disk Access for the binary, or the app's READ CLOCK DRIVE), and `/health`
  carries `drive_error`. The app's DEVICE room says `MOUNTED · pccd CANNOT READ IT` and names the reason.
