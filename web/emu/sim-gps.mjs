// Virtual GPS for the clock4 WASM emulator (Phase 2).
// Generates real NMEA (RMC + GSV, correct XOR checksums) and PPS edges, and drives them into
// the firmware's OWN reception path — decodeRMC / decodeGSV / the installed PPS handler / the
// per-second PendSV engine — so acquisition, fix, discipline and the precision ladder all run
// in the real firmware. The sim is the master 1 Hz clock; PPS re-zeros the firmware's phase.

const pad = (n, w) => String(n).padStart(w, '0');

function checksum(body) {          // body = chars between '$' and '*'
  let s = 0;
  for (let i = 0; i < body.length; i++) s ^= body.charCodeAt(i);
  return s.toString(16).toUpperCase().padStart(2, '0');
}
const sentence = (body) => `$${body}*${checksum(body)}\r\n`;

function fmtLat(lat) {
  const hemi = lat < 0 ? 'S' : 'N';
  lat = Math.abs(lat);
  const deg = Math.floor(lat);
  const min = (lat - deg) * 60;
  return `${pad(deg, 2)}${min.toFixed(4).padStart(7, '0')},${hemi}`;
}
function fmtLon(lon) {
  const hemi = lon < 0 ? 'W' : 'E';
  lon = Math.abs(lon);
  const deg = Math.floor(lon);
  const min = (lon - deg) * 60;
  return `${pad(deg, 3)}${min.toFixed(4).padStart(7, '0')},${hemi}`;
}

// $GxRMC — time, fix status, position, date. `valid` -> 'A' (fix) or 'V' (searching).
function rmc(date, lat, lon, valid) {
  const t = `${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}.00`;
  const d = `${pad(date.getUTCDate(), 2)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCFullYear() % 100, 2)}`;
  const body = `GPRMC,${t},${valid ? 'A' : 'V'},${fmtLat(lat)},${fmtLon(lon)},0.0,0.0,${d},,`;
  return sentence(body);
}
// $GxGSV — satellites in view (only the count field is consumed by decodeGSV).
function gsv(sats) {
  return sentence(`GPGSV,1,1,${pad(Math.min(sats, 99), 2)},01,45,090,40`);
}
// $GxGSV from a REAL sat list [{prn,el,az,cn0}] — up to 4 sats per message, count in field 3.
function gsvReal(sats) {
  const total = Math.max(1, Math.ceil(sats.length / 4));
  const lines = [];
  for (let m = 0; m < total; m++) {
    let body = `GPGSV,${total},${m + 1},${pad(sats.length, 2)}`;
    for (const s of sats.slice(m * 4, m * 4 + 4))
      body += `,${pad(+s.prn, 2)},${pad(Math.max(0, Math.round(s.el)), 2)},${pad(Math.round(s.az), 3)},${pad(Math.round(s.cn0), 2)}`;
    lines.push(sentence(body));
  }
  return lines;
}

export class VirtualGPS {
  /**
   * @param emu   the cwrapped emulator API (feedNmea, pps, pendsv, pendsvPending, tick...)
   * @param opts  { lat, lon, acquireSec }
   */
  constructor(emu, { lat = 51.4779, lon = -0.0015, acquireSec = 6, satProvider = null } = {}) {
    this.emu = emu;
    this.lat = lat; this.lon = lon;
    this.acquireSec = acquireSec;
    this.satProvider = satProvider;  // () => [{prn,el,az,cn0}] of REAL sats in view, or null
    this.shownSats = [];             // the sats actually reported this second (for the app to plot)
    this.signal = true;            // GPS antenna "connected"
    this.elapsed = 0;              // simulated seconds since power-on
    this._sec = -1;                // last integer second we serviced
    this._burst = false;           // NMEA burst emitted for the current second?
    this.state = 'ACQUIRING';
    this.sats = 0;
  }

  setSignal(on) { this.signal = on; }

  satsAt(sec) {                    // ramp 0 -> ~11 over the acquisition window
    if (!this.signal) return 0;
    return Math.min(11, Math.max(0, Math.floor(sec * 11 / this.acquireSec)));
  }

  // Called every animation frame with the real seconds elapsed since the previous call.
  // Advances the sim clock, fires PPS at each second boundary, emits the NMEA burst mid-second.
  advance(dt, wallDate) {
    this.elapsed += dt;
    const sec = Math.floor(this.elapsed);
    const phase = this.elapsed - sec;

    if (sec !== this._sec) {       // crossed a 1 Hz boundary
      this._sec = sec;
      this._burst = false;
      const locked = this.signal && sec >= this.acquireSec;
      if (locked) { this.emu.pps(); this._drainPendSV(); }   // discipline the phase
      this.sats = this.satsAt(sec);
      this.state = !this.signal ? 'NO SIGNAL'
                 : locked ? 'LOCKED'
                 : 'ACQUIRING';
    }

    // NMEA burst ~0.30 s into the second (as a real receiver reports the fix just taken)
    if (!this._burst && phase >= 0.30) {
      this._burst = true;
      if (this.signal) {
        const locked = sec >= this.acquireSec;
        this.emu.feedNmea(rmc(wallDate, this.lat, this.lon, locked));
        if (this.satProvider) {
          // REAL constellation: report the top-N by elevation, ramping N up during acquisition.
          const all = this.satProvider() || [];
          const n = locked ? all.length : Math.floor(all.length * Math.min(1, sec / this.acquireSec));
          this.shownSats = all.slice(0, n);
          this.sats = this.shownSats.length;
          for (const line of gsvReal(this.shownSats)) this.emu.feedNmea(line);
        } else if (this.sats > 0) {
          this.emu.feedNmea(gsv(this.sats));
        }
        this._drainPendSV();
      }
    }
  }

  // PendSV is what the firmware requests at every second boundary (setPrecision + sat ageing).
  _drainPendSV() { if (this.emu.pendsvPending()) this.emu.pendsv(); }
}
