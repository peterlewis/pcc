The spec is the deliverable — I'll return it directly as my response text rather than only to a file. Here is the authoritative render spec.

---

# PRECISION CLOCK Mk IV — AUTHORITATIVE EMULATOR RENDER SPEC

## Unit & frame conventions

- **Unit `H` = digit-cell-height = 1.0 = 34.2 mm** (RevD cover height, `colons.scad h=34.2`). This matches the existing `clockface.js` `GEO.cellH`. **1 mm = 0.029240 H.**
- All coordinates are **board-local**, origin at each board's **top-left corner**, **+x right, +y down** (screen convention — the render already draws +y down; the SCAD y-down data becomes y-up only at its final `rotate([180,0,0])` display step, which the emulator emulates per-board, see §Inversion).
- The existing LED display surface (`clockface.js`) uses this exact frame already; this spec adds the **physical acrylic chrome** (outline, holes, buttons, sensor, hinge) that the current emulator does not draw. The display digits herein are given only to anchor the chrome to the existing render — do not re-derive them.

## Source-of-truth & conflict resolution

- **Geometry → CAD** (`precision-clock.scad`, `colons.scad`, the `pc-face-*.svg`). Every number below is derived from `precision-clock.scad` constants (`PX0=6, PX1=271.365, DY0=5.44, DY1=40, TY0=40, TY1=74.56`, pins `A=(12,34) B=(12,46)`) and `colons.scad` (`w=12, h=34.6, buttons [w/2,h/2±4.5] d=3.5, sensor d=5`). The prose extractions had several wrong/interpolated values (e.g. a bogus "colon at x=56/116", DP diameter, a fictitious per-board button-vs-sensor split); I used the SCAD instead.
- **Side / logical placement → firmware.** Buttons live on the **date board** (PB3, PC13); the ambient sensor + PPS on the **time board** (ADC1_IN10). Confirmed against `switchcover()` on `date_assembly` and `vtt9812fh()` on `time_assembly` in the SCAD.
- **LEFT / RIGHT (viewer):** In the raw closed-CAD frame **both** covers sit at the board **right edge** (`x=259.365`). The task requires buttons **LEFT**, sensor **RIGHT** — this is the assembled-viewer convention, and it is correct because the **date board is mounted 180°-inverted** (`rotate([180,0,0])`, firmware `inverted` flag), which reflects its right-edge switchcover to the viewer's **left**. This spec emits coordinates in the **viewer frame** (post-inversion) so buttons render left, sensor renders right, exactly as asked. Raw CAD-frame positions are noted in `_cadNote` fields for traceability.

---

## JSON — all coordinates in H-units

```json
{
  "unit": { "H_mm": 34.2, "mm_per_H": 0.029240, "frame": "board-local, origin top-left, +x right, +y down (viewer frame)" },

  "material": {
    "acrylic": {
      "appliesTo": ["time_board.outline", "date_board.outline", "hinge.leaf_plates", "hinge.knuckle_capsule"],
      "thickness_mm": 3,
      "note": "Boards AND hinge leaves/capsule are the SAME 3 mm cast acrylic — render with identical fill, edge and bevel treatment.",
      "fill": "#22262c",
      "fillAlpha": 0.82,
      "edgeStroke": "#0d0f12",
      "edgeStrokeW_H": 0.006,
      "bevelHighlight": "#3a4048",
      "innerCutStroke": "#05070a"
    },
    "led": { "on": "#ff3b2e", "dim": "#4d1813", "glow": "rgba(255,59,46,0.55)" },
    "pcbInset": "#101215",
    "delrinWhiteLeaf": "#eceae4",
    "delrinBlackLink": "#17191d",
    "pin": "#b9bfc8"
  },

  "time_board": {
    "_desc": "HH:MM:SS.mmm — 9 seven-seg digits, 2 colon cells, 1 DP, sensor cover on RIGHT edge",
    "outline": {
      "w": 7.7592, "h": 1.0105,
      "cornerRadius_H": 0.0,
      "hingeNotch": {
        "_desc": "r6 concave quarter-arc bitten out of the LEFT edge, concentric about hinge pin B",
        "edge": "left",
        "arcCenter": { "cx": 0.1754, "cy": 0.5053 },
        "r": 0.1754,
        "sweepDeg": [90, 0],
        "_cadNote": "SCAD time_pane2d: arcpts(B,6,90,0); B=(12,46) master; notch relieves the pane around pin B"
      }
    },
    "digits": [
      { "id": "H0", "cx": 0.7018, "w": 0.4094, "role": "big" },
      { "id": "H1", "cx": 1.4035, "w": 0.4094, "role": "big" },
      { "id": "M0", "cx": 2.4561, "w": 0.4094, "role": "big" },
      { "id": "M1", "cx": 3.1579, "w": 0.4094, "role": "big" },
      { "id": "S0", "cx": 4.2105, "w": 0.4094, "role": "big" },
      { "id": "S1", "cx": 4.9123, "w": 0.4094, "role": "big", "dp": true },
      { "id": "ms0", "cx": 5.6140, "w": 0.4094, "role": "small" },
      { "id": "ms1", "cx": 6.3158, "w": 0.4094, "role": "small" },
      { "id": "ms2", "cx": 7.0175, "w": 0.4094, "role": "small" }
    ],
    "_digitCellPitch": 0.7018,
    "_digitVCenter": 0.5053,
    "colons": [
      { "id": "colonL", "cx": 1.7544, "cellW": 0.3509, "topDotCy": 0.6652, "botDotCy": 0.3348, "dotDia": 0.0921 },
      { "id": "colonR", "cx": 3.5088, "cellW": 0.3509, "topDotCy": 0.6652, "botDotCy": 0.3348, "dotDia": 0.0921 }
    ],
    "decimalPoint": {
      "id": "DP_S1", "attachedTo": "S1",
      "dia": 0.0824,
      "offsetXbeyondGlyphRight": 0.0579,
      "offsetYaboveGlyphBottom": 0.0363
    },
    "screwHoles": [
      { "id": "T_hingeLeaf_top",  "cx": 0.1754, "cy": 0.5053, "r": 0.0439, "group": "hinge" },
      { "id": "T_hingeLeaf_bot",  "cx": 0.1754, "cy": 0.8351, "r": 0.0439, "group": "hinge" },
      { "id": "T_mount_topRight", "cx": 7.5838, "cy": 0.1909, "r": 0.0439, "group": "right" },
      { "id": "T_mount_botRight", "cx": 7.5838, "cy": 0.8196, "r": 0.0439, "group": "right" },
      { "id": "T_mount_ctrRight", "cx": 7.5838, "cy": 0.5053, "r": 0.0731, "group": "right", "note": "5 mm large center/sensor-alignment bore; coincident with the sensor cover" }
    ],
    "opticalSensor": {
      "id": "LDR_VTT9812FH", "side": "right",
      "cx": 7.4083, "cy": 0.5053,
      "windowDia": 0.1462,
      "coverW": 0.3509, "coverH": 1.0117,
      "_desc": "5 mm photodiode window at pane vertical center on the RIGHT edge",
      "_cadNote": "vtt9812fh() on time_assembly, place_cover(259.365,(TY0+TY1)/2); cover 12x34.6 mm; window d=5, boss d=7 h=2.8"
    },
    "buttons": []
  },

  "date_board": {
    "_desc": "DD row — 10 seven-seg digits; mounted 180°-inverted; button cover on the (viewer-)LEFT edge",
    "inverted": true,
    "outline": {
      "w": 7.7592, "h": 1.0105,
      "cornerRadius_H": 0.0,
      "hingeNotch": {
        "_desc": "r6 concave quarter-arc on the hinge edge, concentric about hinge pin A",
        "edge": "left_cadframe",
        "arcCenter": { "cx": 0.1754, "cy": 0.5053 },
        "r": 0.1754,
        "sweepDeg": [-90, 0],
        "_cadNote": "SCAD date_pane2d: arcpts(A,6,-90,0); A=(12,34) master"
      }
    },
    "digits": [
      { "id": "D0", "cx": 0.7018, "w": 0.4094 },
      { "id": "D1", "cx": 1.4035, "w": 0.4094 },
      { "id": "D2", "cx": 2.1053, "w": 0.4094 },
      { "id": "D3", "cx": 2.8070, "w": 0.4094 },
      { "id": "D4", "cx": 3.5088, "w": 0.4094 },
      { "id": "D5", "cx": 4.2105, "w": 0.4094 },
      { "id": "D6", "cx": 4.9123, "w": 0.4094 },
      { "id": "D7", "cx": 5.6140, "w": 0.4094 },
      { "id": "D8", "cx": 6.3158, "w": 0.4094 },
      { "id": "D9", "cx": 7.0175, "w": 0.4094 }
    ],
    "_digitCellPitch": 0.7018,
    "_digitVCenter": 0.5053,
    "screwHoles": [
      { "id": "D_hingeLeaf_top", "cx": 0.1754, "cy": 0.1754, "r": 0.0439, "group": "hinge" },
      { "id": "D_hingeLeaf_bot", "cx": 0.1754, "cy": 0.5053, "r": 0.0439, "group": "hinge" },
      { "id": "D_mount_topRight","cx": 7.5838, "cy": 0.1690, "r": 0.0439, "group": "right" },
      { "id": "D_mount_umRight", "cx": 7.5838, "cy": 0.3737, "r": 0.0512, "group": "right" },
      { "id": "D_mount_lmRight", "cx": 7.5838, "cy": 0.6368, "r": 0.0512, "group": "right" },
      { "id": "D_mount_botRight","cx": 7.5838, "cy": 0.8415, "r": 0.0439, "group": "right" }
    ],
    "buttons": {
      "side": "left",
      "coverW": 0.3509, "coverH": 1.0117,
      "coverCx_viewer": 0.1754,
      "coverCy": 0.5053,
      "items": [
        { "id": "BTN1_mode",   "cx": 0.1754, "cy": 0.3743, "r": 0.0512, "logicalPin": "PB3",  "code": "0x91" },
        { "id": "BTN2_toggle", "cx": 0.1754, "cy": 0.6374, "r": 0.0512, "logicalPin": "PC13", "code": "0x92" }
      ],
      "_bothHeldReset": "0x93 (NVIC_SystemReset on time board)",
      "_buttonVerticalOffset_H": 0.1316,
      "_buttonSpacing_H": 0.2632,
      "_cadNote": "switchcover() on date_assembly, holes [w/2,h/2-4.5]=[6,12.8] and [6,21.8] d=3.5. Cover sits at CAD x=259.365 (right edge); reflects to viewer-LEFT under the board's 180 inversion.",
      "opticalSensor": null
    }
  },

  "hinge": {
    "_desc": "Two coplanar sliding leaves + a stadium link capsule, pivoting on two pins 12 mm apart. SAME 3 mm acrylic as the boards.",
    "pins": [
      { "id": "pinA", "cx": 0.1754, "cy_dateBottom": 0.9942, "r": 0.0409, "role": "date-board pivot (stage 1, 90 deg)" },
      { "id": "pinB", "cx": 0.1754, "cy_timeTop": 0.1754, "r": 0.0395, "role": "link-block pivot (stage 2, 90 deg)" }
    ],
    "_pinSpacing_H": 0.3509,
    "_pinSpacing_mm": 12,
    "knuckleCapsule": {
      "_desc": "The 12 x 24 mm stadium spanning both pins — hull of two r6 circles.",
      "w": 0.3509,
      "length": 0.7018,
      "endCapR": 0.1754,
      "boltHoleR": 0.0439,
      "layers": [
        { "id": "front_acrylic", "material": "acrylic",         "thickness_mm": 3 },
        { "id": "black_link6",   "material": "delrinBlackLink",  "thickness_mm": 6 },
        { "id": "white_grip3",   "material": "delrinWhiteLeaf",  "thickness_mm": 3 }
      ]
    },
    "leafPlates": [
      { "id": "date_leaf", "material": "delrinWhiteLeaf", "w": 0.3509, "attachPin": "pinA",
        "bolts_H": [ { "cx": 0.1754, "cy": 0.1754 }, { "cx": 0.1754, "cy": 0.5053 } ],
        "_cadNote": "leaf2d(A,DY0,[[12,11.44],[12,22.72]]); 12 mm wide column + r6 end-cap about pin" },
      { "id": "time_leaf", "material": "delrinWhiteLeaf", "w": 0.3509, "attachPin": "pinB",
        "bolts_H": [ { "cx": 0.1754, "cy": 0.5053 }, { "cx": 0.1754, "cy": 0.8351 } ],
        "_cadNote": "leaf2d(B,TY1,[[12,57.28],[12,68.56]])" }
    ],
    "leafWidth_H": 0.3509,
    "leafWidth_mm": 12
  },

  "assemblyGap": {
    "rowGap_H": 0.34,
    "_desc": "Vertical clearance between date row and time row in the current emulator layout (clockface.js ROW_GAP)."
  },

  "liveIndicator": {
    "_desc": "Red dot + word LIVE, shown ONLY when applyDeviceFrame() is mirroring a real connected device.",
    "visibleWhen": "deviceFrame != null (serial device attached & streaming)",
    "anchor": "top-right of the overall clock frame, outside the acrylic pane bounds",
    "position_H": { "x_fromRightEdge": -0.15, "y_fromTopEdge": -0.28 },
    "dot": { "r": 0.045, "color": "#ff2d20", "glow": "rgba(255,45,32,0.7)", "pulseHz": 1.0 },
    "label": { "text": "LIVE", "gap_H": 0.09, "heightApprox_H": 0.12, "color": "#ff2d20", "weight": 700, "letterSpacing": "0.15em" }
  }
}
```

---

## Render notes (materials, layering, appearance)

**Layering, back-to-front.** (1) dark inset backer `#101215` (PCB); (2) LED digit/colon/DP art — the existing `clockface.js` pass, unchanged; (3) the **3 mm acrylic pane** as a single translucent overlay (`#22262c` @ 0.82 alpha) covering the whole board, with hole cut-outs punched through it; (4) hinge leaves + knuckle capsule (same acrylic treatment, drawn continuous with the pane at the left edge — they read as one piece of material); (5) cover modules (buttons / sensor) as opaque black `#17191d` caps sitting proud of the acrylic; (6) the LIVE badge on top of everything.

**Acrylic material (boards AND hinge — identical treatment).** Cast dark acrylic. Fill `#22262c` at ~0.82 alpha over the dark backer so the LEDs glow through faintly where unlit. Give every acrylic edge a 1–2 px inner bevel: a bright rim `#3a4048` on the top/left edges and a dark rim `#0d0f12` on the bottom/right, to read as a 3 mm-thick sheet. **The hinge leaves and the knuckle capsule use the exact same fill, alpha, and bevel** — they are literally the same 3 mm acrylic layer as the front pane, so do not tint or outline them differently. The hinge notch is a **concave** relief cut on the pane's hinge edge; render it as material *removed* (a quarter-circle bite), with the concave edge carrying the same bevel.

**Screw / mounting holes.** Each board shows the CAD count: **2 hinge-side holes** (`r≈0.044 H` ≈ 1.5 mm) near the left edge + **~4 holes down the right edge** (three `r≈0.044`, plus the larger `r≈0.073 H` ≈ 5 mm bore on the time board that doubles as the sensor alignment bore; the date board's two middle-right holes are the slightly-larger `r≈0.051 H` ≈ 1.75 mm). Draw each as a punched hole: a dark bore `#05070a` with a thin bright inner bevel arc top-left (countersink glint). They cut cleanly through the acrylic overlay to the backer.

**Buttons (LEFT, on the date board).** Two tactile **domed caps**, not threaded nuts — `switchcover()` is a snap-on plastic bezel with 3.5 mm through-holes over silicone/plastic button stems. Render each as a raised black dome `#17191d`, `r≈0.051 H` (3.5 mm), with a soft top-left specular highlight and a faint contact shadow ring on the acrylic to sell the "proud of the surface" look. Center them on the viewer-left edge at `cy 0.374` and `0.637` (±4.5 mm about pane center, 9 mm apart). They ride on a 12 mm-wide black cover strip flush to the left edge. Optional: on press, sink the dome ~1 px and brighten the rim.

**Optical sensor (RIGHT, on the time board).** A single **photodiode window** — a 5 mm circular aperture (`r≈0.073 H`) at pane vertical center on the right edge, centered on a 12 mm black cover strip. Render as a dark glassy well: near-black fill with a subtle blue-grey radial sheen and a thin raised bezel ring (`vtt9812fh` has a `d=7 h=2.8` boss around the `d=5` window). It should read as a small round sensor eye, distinct from the domed buttons and from the plain screw bores. Do **not** put buttons on this side.

**Hinge assembly.** Two acrylic/Delrin leaf plates (12 mm wide columns, one per board) meeting at the **stadium knuckle capsule** (12 × 24 mm — hull of two r6 end-caps). Two pins 12 mm apart (`0.351 H`): **pin A** (date pivot) and **pin B** (link pivot), each a bright metal cylinder `#b9bfc8` `r≈0.04 H` with a small top highlight. Bolt holes on the leaves match the board hinge-side holes. In the closed pose the leaves + capsule stack sits at the far left, bridging the date row above and time row below; render the front-facing acrylic layer of the capsule with the standard acrylic treatment, and let the black `#17191d` link and white `#eceae4` grip layers show only as a thin edge sliver behind it (they are the 6 mm + 3 mm Delrin layers underneath).

**180° inversion (date board).** The date board is physically inverted, so in the viewer frame its glyphs use `LUT_DATE_INV`, its DP point-reflects to the top-left of the digit, and — critically for this spec — its **button cover appears on the viewer's LEFT** even though the CAD places it at the board's right edge. The emulator already handles glyph/DP inversion; apply the same reflection to the button-cover x-position (emit `coverCx_viewer = 0.1754`, i.e. left edge).

**LIVE indicator.** Show **only** when a real device is connected and streaming (`state.deviceFrame != null`, set by `applyDeviceFrame()`). Place it just **outside the top-right corner** of the acrylic frame: a `r≈0.045 H` red dot `#ff2d20` with a soft glow, gently pulsing at ~1 Hz, followed by the word **"LIVE"** in bold red, letter-spaced, ~`0.12 H` tall, `0.09 H` to the right of the dot. Hide it entirely in standalone/simulated mode so the badge unambiguously means "mirroring hardware."

---

## Files referenced
- Ground-truth geometry: `/Users/peter/Developer/ML/Claude/pcc/clock4/cad/precision-clock.scad`, `/Users/peter/Developer/ML/Claude/pcc/clock4/cad/colons.scad`
- Board outlines: `/Users/peter/Developer/ML/Claude/pcc/clock4/cad/pc-face-time.svg`, `/Users/peter/Developer/ML/Claude/pcc/clock4/cad/pc-face-date.svg`, `/Users/peter/Developer/ML/Claude/pcc/clock4/cad/hinge.svg`
- Current render model (defines H, digit/colon/DP art to preserve): `/Users/peter/Developer/ML/Claude/pcc/web/js/clockface.js`
- Spec JSON also written to: `/private/tmp/claude-501/-Users-peter-Developer-ML-Claude-pcc/704177bc-1d90-4ec5-a1b9-e0f5bc36ccdd/scratchpad/render-spec.json`