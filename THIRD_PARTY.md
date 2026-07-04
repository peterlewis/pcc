# Third-party assets & licenses

PCC Web itself is MIT (see [LICENSE](LICENSE)). It bundles a few third-party assets, each under its own license:

| Asset | Where | Author / source | License |
| --- | --- | --- | --- |
| **B612** & **B612 Mono** fonts | `web/fonts/*.woff2` | Airbus / Polarsys | SIL Open Font License 1.1 |
| **land-110m** coastline (TopoJSON) | `web/data/land-110m.json` | [world-atlas](https://github.com/topojson/world-atlas) (Natural Earth) | Natural Earth data: public domain · world-atlas tooling: ISC |
| **globe.gl** v2.41.3 (legacy 3D globe) | `web/globe/globe.gl.min.js` | [Vasco Asturiano](https://github.com/vasturiano/globe.gl) | MIT |
| Earth / night-sky textures (legacy 3D globe) | `web/globe/*.jpg`, `*.png` | NASA Visible Earth | public domain |
| **esbuild** (build tool, not shipped) | dev dependency | [Evan Wallace](https://github.com/evanw/esbuild) | MIT |

The astronomy, NMEA, satellite and timing code under `web/js/` is original work (some of it ported from this project's own macOS `Astronomy.swift`), under the repo's MIT license.

Hardware design and firmware for the Precision Clock Mk IV are mitxela's — see [clock4](https://github.com/mitxela/clock4). This repository contains none of it.
