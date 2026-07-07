# PCC Web

The Precision Clock Companion app — source. Built to `../docs/` by CI and served on GitHub Pages. See the [top-level README](../README.md) for what it is and how it's deployed.

> [!NOTE]
> The clock face is the real `clock4` firmware compiled to WebAssembly (see `emu/`), not a re-implementation. Everything renders from the firmware's own display buffers.

## Requirements

- Chromium-based browser (Chrome, Edge, Arc, Brave, Opera) for the hardware connection — Safari and Firefox don't implement Web Serial, but can still run the emulator.
- HTTPS or `localhost`.

## Run locally

```bash
bash serve.sh          # http://localhost:8765 — live source, no build step
```

`file://` won't work — the modules need HTTP(S). To produce the deployed static bundle:

```bash
npm install && node build.mjs      # → ../docs/ (needs emscripten to compile the firmware)
```

## Structure

```
web/
├── index.html          # the UI: a dc-lite template with {{binding}} placeholders
├── css/                # base.css + pcc-tokens.css (inlined at build; light/dark via CSS vars)
├── build.mjs           # bundles the app + compiles the firmware WASM → ../docs/
├── emu/                # the firmware emulator
│   ├── firmware/       #   clock4 submodule (@ rollup) — the real C source
│   ├── phase1/         #   emscripten shim (main_wrap.c + HAL stubs) + build.sh + conformance suite
│   └── clock-fw.mjs    #   compiled WASM (gitignored; built from source)
└── js/
    ├── app-controller.js   # the app: state machine, rooms, the rAF drive loop, all bindings
    ├── dc-lite.js          # tiny template/reactive-render runtime
    ├── clockface.js /-svg.js  # the two clock-face renderers (canvas + SVG), fed device frames
    ├── emu-driver.js       # wraps the WASM firmware + virtual GPS + input shims
    ├── sim-gps (emu/) / sim.js  # virtual GPS + the simulation session/state
    ├── realdev.js          # bridges a real Mk IV (Web Serial) into the same session state
    ├── serial.js / nmea.js / ppsts.js  # Web Serial, NMEA parsers, $PMTXTS timing
    ├── charts.js           # every SKY/TIMING chart (polar, globe, map, phase, drift, …)
    ├── sat-tracker.js / satpass.js  # live TLE → SGP4-lite sat positions
    ├── default-config.js   # the golden config.txt the app + emulator boot from
    ├── review.js / decimate.js  # the recorded-data scrub timeline
    ├── telemetrylog.js / skytrailstore  # opt-in persistence
    └── datasources.js / datalink/  # REST date-row sources; Timex Datalink (hidden, WIP)
```

## Honesty model

Three states, never mixed: **Standby** (system time, no telemetry), **Simulation** (opt-in, labelled, virtual GPS through the real firmware path), **Connected** (a real Mk IV; its data never mingles with simulated). Persistence is opt-in and kind-separated.

## Feedback

[GitHub issues](https://github.com/peterlewis/pcc/issues) — prefix web-specific bugs with `[web]`.
