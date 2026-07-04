# hinge-demo — the Mk IV fold, verified

Reference animation + stills for the **entry interaction** in `DESIGN_BRIEF.md` §6.2:
the app opens the way the physical clock opens.

## The real motion

The Mk IV's desk state is **folded**: date row stacked above the time row, a two-pin
hinge link on the **left edge**. Opening is a **two-stage fold, entirely in the face
plane** — nothing lifts out of it, and the **time half never moves**:

1. **Stage 1** (`t` 0→0.5): the **date (top) half swings 90° counter-clockwise**
   about the **upper pin** (on the hinge column, 6 mm above the row seam).
2. **Stage 2** (`t` 0.5→1): the **hinge link itself rotates 90° CCW** about the
   **lower pin** (6 mm below the seam, 12 mm from the first), **carrying the date
   half with it** — which lands to the left, 180°-rotated, coplanar:
   one long bar, **date | hinge | time**.

The leaf end-caps and board notch fillets are concentric r6 arcs about the pins —
a coplanar sliding bearing. Both rotations are CCW on screen, sequential, mechanical.

| file | contents |
|---|---|
| `fold.gif` | the full fold, `t` 0→1, fixed orthographic camera |
| `closed.png` / `half.png` / `open.png` | face-on stills at `t` = 0 / 0.5 / 1 |

## Source of truth

`clock4/cad/precision-clock.scad` — parametric assembly built from mitxela's own
cut files (`acrylic-case/3mm-acrylic.svg`, `hinge.svg`, `colons.scad`), kinematics
decoded numerically from the three keyframes `web/3mm-acrylic-{closed,half,open}.svg`
and render-verified against them (bbox agreement ≤ 5 µm at t = 0 / 0.5 / 1).

Regenerate (OpenSCAD ≥ 2021, macOS path shown):

```sh
OS='/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD'
cd clock4/cad
# stills
for T in 0 0.5 1; do
  $OS -o face-t$T.png --imgsize 1500,900 --projection=o --autocenter --viewall \
     --camera 0,0,0,0,0,0,700 -D t=$T precision-clock.scad
done
# animation frames (fixed camera so nothing jumps between frames)
for i in $(seq 0 39); do
  $OS -o f$(printf %02d $i).png --imgsize 1280,720 --projection=o \
     --camera 6,-40,0,0,0,0,330 -D t=$(python3 -c "print($i/39)") precision-clock.scad
done
ffmpeg -framerate 20 -i f%02d.png \
  -vf "split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse,scale=800:-1" fold.gif
```

## History

An earlier `lift.gif` / `model-clock.scad` here showed a single-pivot "clapperboard"
lift of the time half — that motion was a guess and is **wrong**; it was superseded
on 2026-07-02 by the keyframe-decoded mechanism above. If a design references
"time half lifts up", it predates this correction.
