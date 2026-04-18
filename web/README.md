# PCC Web

Browser port of [PCC](../README.md) — drives a Precision Clock Mk IV over [Web Serial](https://developer.mozilla.org/docs/Web/API/Web_Serial_API), renders the live sky view, 3D globe, and pass history, all as a static site.

> [!WARNING]
> **Work in progress / proof-of-concept — not even beta.** The Mac app is the primary, supported companion. This web port exists to cover non-Mac users with a deliberately reduced subset and to explore how much of the app maps cleanly to browser APIs. **Not all features function yet** — expect rough edges, missing polish, half-wired controls, and breaking changes without notice.

**[Open PCC Web →](https://peterlewis.github.io/pcc/web/)**

## Requirements

- **Chromium-based browser** — Chrome, Edge, Arc, Brave, Opera. Safari and Firefox don't implement Web Serial and have no public roadmap for it.
- **Desktop OS.** Android Chrome technically supports Web Serial but pairing a USB device is fiddly; iOS Safari has no support at all.
- **HTTPS or `localhost`.** GitHub Pages provides HTTPS; the live link above works out of the box.

## What works (roughly)

Not all of the below is polished — some controls are half-wired or flaky. Treat this as a rough inventory, not a promise.

- Connect over USB and drive the clock: display modes, free text (with marquee scroll), countdowns, brightness lock, raw `key = value` commands
- **Polar sky view** — live satellites, sector heatmap (peak SNR per 5°×5° cell, u-center style), horizon mask, age-faded trails with adaptive smoothing
- **3D globe** — offline globe.gl bundle, day/night terminator, satellites + trails + sun/moon (shares the exact same HTML as the Mac app)
- **Pass history** — IndexedDB persistence, configurable retention (1 hour → unlimited), time-window filter (live → 30d → all), clear-history guard
- GPS info, Maidenhead grid, sun/moon altitude + azimuth, sunrise/sunset
- Raw serial monitor
- Automatic light / dark mode following the OS

## What doesn't (by design)

| Feature | Why it's Mac-only |
| --- | --- |
| NTP time server | Browsers can't open UDP listen sockets |
| Firmware / timezone updates | No USB mass-storage mount from a browser |
| Native map view | MapKit-only (a Leaflet fallback could be added) |
| WeatherKit | Apple-only |
| On-device AI insights | Apple Foundation Models are Mac-only |

For any of the above, use the [Mac app](https://github.com/peterlewis/pcc/releases).

## Run locally

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc
bash web/serve.sh
```

That serves `web/` on `http://localhost:8765`. Web Serial works on `localhost` without HTTPS; any other origin needs HTTPS.

Opening `web/index.html` directly via `file://` won't work — browsers block ES modules and Web Serial from that origin. The page detects this and shows a hint, but just run the script above.

## Structure

```
web/
├── index.html          # UI shell, tabs, controls
├── css/app.css         # single-file styling; CSS-variable palette auto-swaps on prefers-color-scheme
├── js/
│   ├── app.js          # DOM wiring; no framework
│   ├── serial.js       # Web Serial wrapper
│   ├── nmea.js         # GGA / RMC / GSV parsers
│   ├── astronomy.js    # sun / moon / sunrise-sunset math
│   ├── satpass.js      # ← mirrors Sources/PCC/SatPass.swift
│   ├── skytrailstore.js# ← mirrors Sources/PCC/SkyTrailStore.swift (IndexedDB)
│   ├── polar.js        # ← mirrors the polar canvas in SkyView.swift
│   └── globe.js        # ← mirrors SkyGlobeView.swift
└── globe/              # ← byte-identical copy of Sources/PCC/Resources/Globe/
    ├── index.html
    ├── globe.gl.min.js
    └── textures…
```

Several JS modules are 1:1 ports of Swift files — see [MAC_PARITY.md](../MAC_PARITY.md) for the mirror convention and how to keep them in sync.

## Feedback

Issues and suggestions on [GitHub](https://github.com/peterlewis/pcc/issues). Prefix web-specific bugs with `[web]` so they're easy to triage separately from Mac-app issues.
