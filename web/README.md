# PCC Web

Browser build of [PCC](../README.md), driving a Precision Clock Mk IV over [Web Serial](https://developer.mozilla.org/docs/Web/API/Web_Serial_API).

> [!WARNING]
> Proof-of-concept. Work in progress. Things may not work. Use the [Mac app](https://github.com/peterlewis/pcc/releases) for the best experience.

**[Open PCC Web →](https://peterlewis.github.io/pcc/web/)**

## Requirements

- Chromium-based browser (Chrome, Edge, Arc, Brave, Opera) on desktop. Safari and Firefox don't implement Web Serial.
- HTTPS or `localhost`.

## What it does

- Drive the clock: display modes, text, countdowns, brightness, raw `key = value` commands
- Polar sky view: live sats, sector heatmap, horizon mask, age-faded trails
- 3D globe (globe.gl, offline — same HTML as the Mac app)
- Pass history in IndexedDB with retention + time-window filter
- GPS info, sun/moon, raw serial monitor
- Follows OS light/dark

## What it doesn't (by design)

| Feature | Why |
| --- | --- |
| NTP server | No UDP listen from a browser |
| Firmware / timezone updates | No USB mass-storage mount |
| Native map | MapKit-only |
| WeatherKit | Apple-only |
| AI insights | Foundation Models are Mac-only |

## Run locally

```bash
git clone https://github.com/peterlewis/pcc.git
cd pcc
bash web/serve.sh
```

Serves on `http://localhost:8765`. `file://` won't work — needs HTTP(S).

## Structure

```
web/
├── index.html          # UI shell, tabs, controls
├── css/app.css         # styling; CSS-var palette auto-swaps on prefers-color-scheme
├── js/
│   ├── app.js          # DOM wiring
│   ├── serial.js       # Web Serial wrapper
│   ├── nmea.js         # GGA / RMC / GSV parsers
│   ├── astronomy.js    # sun / moon / sunrise-sunset
│   ├── satpass.js      # ← mirrors Sources/PCC/SatPass.swift
│   ├── skytrailstore.js# ← mirrors Sources/PCC/SkyTrailStore.swift
│   ├── polar.js        # ← mirrors SkyView.swift
│   └── globe.js        # ← mirrors SkyGlobeView.swift
└── globe/              # ← byte-identical copy of Sources/PCC/Resources/Globe/
```

Several JS modules mirror Swift files 1:1 — see [MAC_PARITY.md](../MAC_PARITY.md).

## Feedback

[GitHub issues](https://github.com/peterlewis/pcc/issues) — prefix web-specific bugs with `[web]`.
