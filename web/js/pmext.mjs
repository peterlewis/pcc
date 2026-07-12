// pmext.mjs — parse the Precision Clock Mk IV's newer proprietary sentences: the
// star-transit predictor's "$PMSTAR" (MODE_STAR) and the oscillator-stability
// ladders "$PMADEV" / "$PMHDEV" (MODE_ADEV). Sibling to ppsts.js, which owns the
// $PMTXT* family; same NMEA-style framing ($…*CC, XOR checksum of the chars
// between '$' and '*'). Must stay in sync with the firmware emitters.
//
// Unlike parsePMTXTS (which reports checksumOK so the Timing room can count link
// errors), these parsers REJECT a corrupt or malformed line outright (return
// null): their consumers keep only the latest sentence, so a bad line is simply
// dropped rather than allowed to replace good data.

// Validate framing + checksum for one `$<tag>,…*CC` line and split the body.
// Returns the comma-split fields (fields[0] === tag) or null — null covers both
// "not this sentence" and "corrupt", which the parsers treat the same way.
function checkedFields(line, tag) {
  if (typeof line !== 'string') return null;
  line = line.trim();
  if (!line.startsWith('$' + tag + ',')) return null;
  const star = line.lastIndexOf('*');
  if (star < tag.length + 2) return null;
  const body = line.slice(1, star);              // chars between '$' and '*'
  const csTxt = line.slice(star + 1, star + 3);  // two hex digits
  let cks = 0;
  for (let i = 0; i < body.length; i++) cks ^= body.charCodeAt(i);
  if (!/^[0-9a-fA-F]{2}$/.test(csTxt) || parseInt(csTxt, 16) !== cks) return null;
  return body.split(',');
}

// Parse one $PMSTAR line — the next local-meridian crossings from MODE_STAR:
//   $PMSTAR,<n>,<src>{,<name>,<sec_to_transit>,<alt_deg>,<dir>}xN*CC
//   n     entry count, 0..8
//   src   'C' = SD-card catalogue (STARS.BIN) · 'B' = baked-in fallback set
//   name  1..4 chars A-Z0-9 (the firmware space-pads short names)
//   sec_to_transit  integer seconds until the star crosses the local meridian
//   alt_deg         integer culmination altitude, 0..90
//   dir   'S'|'N' — culminates due south / due north of the zenith
// Returns { n, src, stars: [{ name, secToTransit, altDeg, dir }] } (names
// trimmed of the firmware's padding) or null on any framing/field violation.
export function parsePMSTAR(line) {
  const f = checkedFields(line, 'PMSTAR');
  if (!f) return null;
  if (!/^\d+$/.test(f[1])) return null;
  const n = parseInt(f[1], 10);
  const src = f[2];
  if (n > 8 || (src !== 'C' && src !== 'B')) return null;
  if (f.length !== 3 + 4 * n) return null;
  const stars = [];
  for (let i = 3; i < f.length; i += 4) {
    const name = f[i].trim();                    // strip the firmware's space padding
    const dir = f[i + 3];
    if (!/^[A-Z0-9]{1,4}$/.test(name)) return null;
    // sec_to_transit may legitimately be slightly negative (a star just past the
    // meridian when the sentence was assembled); altitude must be 0..90.
    if (!/^-?\d+$/.test(f[i + 1]) || !/^\d+$/.test(f[i + 2])) return null;
    const secToTransit = parseInt(f[i + 1], 10);
    const altDeg = parseInt(f[i + 2], 10);
    if (altDeg > 90 || (dir !== 'S' && dir !== 'N')) return null;
    stars.push({ name, secToTransit, altDeg, dir });
  }
  return { n, src, stars };
}

// Parse one $PMADEV or $PMHDEV line — the firmware's stability ladder (Allan
// deviation, or Hadamard deviation for the drift-immune variant). Same shape:
//   $PMADEV,<epoch>,<tau0>,<valid>,<noct>{,<sigma_k>}xnoct*CC
//   epoch  unix seconds at emit
//   tau0   base averaging interval τ₀ in seconds (currently 1)
//   valid  phase samples currently in the firmware's ring
//   noct   published octaves; sigma_k is the dimensionless fractional-frequency
//          deviation at τ = τ₀·2^k (scientific notation, e.g. 3.2e-11)
// Returns { kind:'adev'|'hdev', epoch, tau0, valid, noct, taus, sigmas } — taus
// pre-expanded to [τ₀, 2τ₀, 4τ₀, …] seconds so chart code never re-derives the
// octave rule — or null on any framing/field violation.
export function parsePMADEV(line) {
  let kind = 'adev';
  let f = checkedFields(line, 'PMADEV');
  if (!f) { f = checkedFields(line, 'PMHDEV'); kind = 'hdev'; }
  if (!f) return null;
  const epoch = +f[1], tau0 = +f[2], valid = +f[3], noct = +f[4];
  if ([epoch, tau0, valid, noct].some(Number.isNaN)) return null;
  if (!(tau0 > 0) || !Number.isInteger(noct) || noct < 0) return null;
  if (f.length !== 5 + noct) return null;
  const taus = [], sigmas = [];
  for (let k = 0; k < noct; k++) {
    const s = +f[5 + k];
    if (Number.isNaN(s)) return null;
    taus.push(tau0 * 2 ** k);
    sigmas.push(s);
  }
  return { kind, epoch, tau0, valid, noct, taus, sigmas };
}
