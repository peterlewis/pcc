# Mac ↔ Web parity

The `pcc` repo ships **two** companion apps for the Precision Clock Mk IV:

- **Native macOS app** (`Sources/PCC/`) — SwiftUI + AppKit, full feature set.
- **Browser port** (`web/`) — static HTML/CSS/ES modules, reduced feature set,
  deployable to GitHub Pages / any static host.

They're sibling implementations, not a shared core — SwiftUI and the
DOM have too little in common for a unified abstraction to pay off.
Instead, the two sides are kept in lockstep by a **mirror convention**
documented here.

## Which files mirror which

### 1:1 file mirrors

Keep these pairs in sync semantically — public API, constants, algorithms.
Internal helper naming can diverge where language idioms demand (e.g. Swift
enums with methods vs JS plain-object namespaces).

| Mac (Swift)                                      | Web (JS)                       | What it owns                                                        |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------- |
| `Sources/PCC/SatPass.swift`                      | `web/js/satpass.js`            | Observation + pass data shape, smoothing, ground track, age tiers, `TimeWindow`, `RetentionWindow` |
| `Sources/PCC/SkyTrailStore.swift`                | `web/js/skytrailstore.js`      | Pass recording, rejoin window, horizon mask + sector heatmap aggregation, retention pruning |
| `Sources/PCC/Views/SkyView.swift` (SkyPlotCanvas)| `web/js/polar.js`              | Polar sky-plot renderer: heatmap, mask, grid, trails, live sats     |
| `Sources/PCC/Views/SkyGlobeView.swift`           | `web/js/globe.js`              | 3D globe host: assembles the JSON shape the shared globe HTML consumes |
| `Sources/PCC/SerialManager.swift` (parsers only) | `web/js/nmea.js`               | GGA / RMC / GSV sentence parsing, GSV multi-message reassembly      |

### Shared assets (byte-identical)

These files are **literally the same bytes in both trees**. The Mac build
copies from `web/globe/` into the app bundle (or vice versa — see commit
history); diff them after edits and copy whichever side you touched into
the other.

| Web path                 | Mac path                                |
| ------------------------ | --------------------------------------- |
| `web/globe/index.html`   | `Sources/PCC/Resources/Globe/index.html`|
| `web/globe/globe.gl.min.js` | `Sources/PCC/Resources/Globe/globe.gl.min.js` |
| `web/globe/earth-day.jpg`| `Sources/PCC/Resources/Globe/earth-day.jpg`|
| `web/globe/earth-night.jpg` | `Sources/PCC/Resources/Globe/earth-night.jpg` |
| `web/globe/night-sky.png`| `Sources/PCC/Resources/Globe/night-sky.png`|

The shared `index.html` uses a small `postHost(channel, body)` router:
on macOS it forwards to `window.webkit.messageHandlers[channel]`
(WKWebView), on the web to `window.parent.postMessage({channel, body})`
(iframe). That's the entire abstraction — no feature branches, just a
5-line shim at the top of the globe's script block.

### Web-only

These have no Swift equivalent — they exist because the browser host is
different from AppKit.

- `web/js/serial.js` — Web Serial API wrapper. Mac uses `IOKit`/`ORSSerialPort`-style code in `SerialManager.swift` which is tightly coupled to the rest of the manager; no clean mirror.
- `web/js/astronomy.js` — port of Apple's celestial math where the Mac uses `CoreLocation`/AppKit-provided sunrise calculations. Close-enough algorithms, not exact parity.
- `web/js/app.js` — DOM wiring + tab management. No Swift analogue (SwiftUI views handle this).
- `web/css/app.css`, `web/index.html` — pure browser UI.

### Mac-only (intentional gaps)

The web port does not — and should not — implement these:

- NTP time server (`NTPServer.swift`) — browsers can't open UDP listen sockets.
- Firmware / timezone updates (`FirmwareUpdate.swift`) — needs USB mass-storage mount.
- Native map view (`MapView.swift`) — requires MapKit.
- WeatherKit integration — Apple-only.
- AI insights (`AIInsights.swift` / Foundation Models) — Apple-only.

If one of these ever gets a browser-viable implementation (e.g. Leaflet
for maps, Open-Meteo for weather), add a row to the 1:1 table above and
move it out of this list.

## Keeping them in sync

### When you touch Swift

1. If the change is in a mirrored file (`SatPass.swift`, `SkyTrailStore.swift`, `SkyView.swift`, `SkyGlobeView.swift`, or the GSV parser in `SerialManager.swift`), **also update the matching `.js` file in the same commit**. Leave a comment in both files pointing at the other.
2. If the change is in the shared globe HTML (`Sources/PCC/Resources/Globe/index.html` or peer assets), **also update `web/globe/*`**. Run `diff -rq web/globe Sources/PCC/Resources/Globe` to confirm they match before committing.

### When you touch JS

Same rule in reverse. The JS files include a header comment saying they
mirror a specific Swift file — keep those pointers accurate.

### Pre-commit sanity checks

```bash
# Byte-identical globe assets
diff -rq web/globe Sources/PCC/Resources/Globe

# JS modules parse
for f in web/js/*.js; do node --check --input-type=module < "$f" || echo "FAIL: $f"; done
```

## Philosophical notes

- **No code-generation from Swift**. SwiftWasm and transpilers were considered and rejected — the cognitive cost of debugging machine-translated JS is worse than maintaining two small, readable ports.
- **No runtime code-sharing (JavaScriptCore embedding)**. Would need a JSContext wrapper, polyfills for browser-only globals (`performance.now`, `crypto.randomUUID`), and an FFI layer for `SatPass` ↔ `SatObservation`. Net complexity > maintaining two files.
- **The shared globe HTML is the one exception** because it's the only place we'd have written the same 300 lines of three.js / globe.gl glue twice. The `postHost` shim is cheap; the Mac-specific ergonomics (keyboard shortcuts, clock overlay gestures) come through the same message channel on both sides.

## Parity status

Last updated 2026-04.

| Feature                          | Mac | Web | Notes                                  |
| -------------------------------- | --- | --- | -------------------------------------- |
| Connect over serial              | ✅  | ✅  | Mac: IOKit; Web: Web Serial            |
| Display modes (text, countdown)  | ✅  | ✅  |                                        |
| Brightness control               | ✅  | ✅  |                                        |
| Raw command entry                | ✅  | ✅  |                                        |
| GPS fix info, Maidenhead         | ✅  | ✅  |                                        |
| Polar sky view — live sats       | ✅  | ✅  |                                        |
| Polar sky view — sector heatmap  | ✅  | ✅  |                                        |
| Polar sky view — horizon mask    | ✅  | ✅  |                                        |
| Polar sky view — trails          | ✅  | ✅  | Adaptive moving-average smoothing      |
| 3D globe                         | ✅  | ✅  | Shared HTML                            |
| Pass history storage             | ✅  | ✅  | Mac: FileManager JSON; Web: IndexedDB  |
| Retention windows                | ✅  | ✅  |                                        |
| Sun / moon / sunrise / sunset    | ✅  | ✅  | Close-enough algorithms on web         |
| Light / dark mode                | ✅  | ✅  | Web: `prefers-color-scheme`            |
| Native map view                  | ✅  | ❌  | MapKit-only                            |
| WeatherKit                       | ✅  | ❌  | Apple-only                             |
| NTP time server                  | ✅  | ❌  | Browser can't listen on UDP            |
| Firmware / timezone updates      | ✅  | ❌  | Needs USB mass-storage                 |
| On-device AI insights            | ✅  | ❌  | Foundation Models are Mac-only         |
