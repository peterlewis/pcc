// datasources.js — REST data-source polling for the PCC date row. Pure, testable helpers +
// a fetch; the controller owns the source list (localStorage), the poll timers, and the push
// to the clock face. Ported from the macOS DataSource (extractValue / applyFormat / rate-limit
// messaging). REST only — the Bash source type is intentionally dropped (no shell in a browser).

// Extract a value from a response body.
//   'json'  — JSON.parse then '.'-split path traversal (object keys + numeric array indices).
//   'regex' — first capture group, else the whole match.
//   'text'/empty path — first trimmed non-empty line (else the whole trimmed body).
export function extractValue(body, mode, opts = {}) {
  const t = String(body == null ? '' : body);
  if (mode === 'regex') {
    try { const m = new RegExp(opts.regex).exec(t); return m ? (m[1] != null ? m[1] : m[0]) : ''; } catch (e) { return ''; }
  }
  if (mode === 'json' && opts.path && opts.path.trim()) {
    let v; try { v = JSON.parse(t); } catch (e) { return ''; }
    for (const seg of opts.path.split('.')) {
      if (seg === '') continue;
      if (v == null) return '';
      if (Array.isArray(v)) { const i = parseInt(seg, 10); v = Number.isFinite(i) ? v[i] : undefined; }
      else if (typeof v === 'object') v = v[seg];
      else return '';
    }
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  const line = t.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length);
  return line || t.trim();
}

// Substitute {v} in the display format; if there's no {v}, just show the value.
export function applyFormat(fmt, value) {
  const v = value == null ? '' : String(value);
  return (fmt && fmt.indexOf('{v}') >= 0) ? fmt.split('{v}').join(v) : (fmt ? fmt : v);
}

// "Key: Value" lines → a headers object.
export function parseHeaders(blob) {
  const h = {};
  for (const line of String(blob || '').split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim(); if (k) h[k] = line.slice(i + 1).trim();
  }
  return h;
}

// Fetch + extract + format one source. Never throws — returns { ok, value?, error? }.
export async function fetchValue(src) {
  try {
    const opt = { headers: parseHeaders(src.headers) };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opt.signal = AbortSignal.timeout(15000);
    const res = await fetch(src.endpoint, opt);
    if (!res.ok) {
      if (res.status === 429 || res.status === 403) {
        const rem = res.headers.get('X-RateLimit-Remaining');
        return { ok: false, error: `HTTP ${res.status}` + (rem != null ? ` · ${rem} req left` : ' · rate-limited') };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const raw = extractValue(await res.text(), src.extractMode || 'json', { path: src.jsonKeyPath, regex: src.regex });
    if (raw === '' || raw == null) return { ok: false, error: 'no value extracted' };
    return { ok: true, value: applyFormat(src.displayFormat, raw) };
  } catch (e) {
    return { ok: false, error: (e && e.name === 'TimeoutError') ? 'timeout' : ((e && e.message) || 'fetch failed') };
  }
}
