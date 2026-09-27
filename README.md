# Printing with Light — an interactive photolithography exhibit

An explorable 3D simulation that teaches how chips are printed. You run the process —
clean, coat, bake, align, expose, bake, develop, etch, inspect — and every knob you turn
changes the physically-modelled result on the wafer in real time.

Available in **English and Brazilian Portuguese** (EN · PT switch in the top-right corner; defaults to the
browser language and remembers the choice).

Built with **Three.js + WebGL + TypeScript** (Vite). Everything is procedural: no models,
no textures, no external assets besides self-hosted fonts.

## Run

```bash
npm install
npm run dev
```

Opens `http://127.0.0.1:5178`. Production build (static, deployable to any host or sub-path):

```bash
npm run build      # → dist/
npm run preview    # serve dist/ locally
```

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` builds and publishes on every push to `main`.

1. Create an empty repository on GitHub (public, for free Pages).
2. Push this project:
   ```bash
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. The site appears at `https://<user>.github.io/<repo>/` (the Actions tab shows progress).
   Re-run the workflow from the Actions tab if the first run started before step 3.

## Two modes

- **Guided** — nine narrated steps for someone who knows nothing about chip fabrication.
  Each step has one idea, one thing to do (hold to clean, dispense & spin, drag the alignment
  pad, expose, flip the resist tone, etch…) and one insight. Optional voice narration (speaker icon).
- **Sandbox** — every process variable is live. The left column shows the printed result
  (CD, edge roughness, dose-to-size, wafer yield), the aerial image, the dose × focus process
  window and seven failure-mode lamps. *Break it on purpose* presets isolate classic failures:
  under/over-exposure, defocus, overlay error, resolution limit, pattern collapse, etch
  punch-through and EUV stochastics.

## Views

- **Fab bench** — spin coater, hot plate, scanner (light source → illuminator → photomask →
  cut-away projection lens with pupil → wafer stage), plasma etcher and an inspection ring
  with the wafer yield map. The wafer travels between stations.
  During exposure you see the **diffraction orders**: the ±1 orders must fit through the pupil
  (NA) for an image to form — switch to g-line and watch them hit the barrel wall.
  *Explode optics* separates the column.
- **Specimen** (microscope loupe; swap with the button or double-click) — a true-scale 3D
  relief of resist on SiO₂ on silicon, with a movable **cross-section** that shows the real
  developed profile (standing-wave scallops, footing, undercut). Layers: *Material*,
  *Design overlay* (intended vs printed, error tint), *Aerial image* (light intensity + print
  threshold contour). Cameras: 3D / Section / Top.

## The model (simplified, but with the right scaling laws)

| Stage | Model |
|---|---|
| Optics | Mask ⊗ Gaussian PSF, σ = 0.23 λ/NA (partial coherence ≈ Abbe cut-off λ/(1.5 NA)) |
| Focus | Extra blur 0.2 · NA · \|Δz\| per depth slice → depth of focus ∝ λ/NA² |
| Resist | 4 depth slices with absorption e^(−αz); acid diffusion (PEB) blur; photon shot noise ∝ 1/√(dose·λ) |
| Standing waves | 1 − m·cos(4πnz/λ) with a node at the substrate, attenuated by PEB |
| Development | Mack-style dissolution rate R(E) integrated through the film (column model for the relief, Dijkstra front for the cross-section) |
| Etch | Anisotropic, selectivity 4:1 — resist is consumed at depth/4 |
| Metrology | CD at half resist height at a metrology site, 3σ edge roughness, dose-to-size, contrast |
| Yield | Per-die dose/focus/overlay variation looked up in the process window + collapse, scum, punch-through and particle defects |

Numbers are illustrative, not a calibrated process. Tone, dose, focus, λ/NA, resist
thickness, development time and etch depth all interact the way they do in a real fab.

## Controls

| Input | Action |
|---|---|
| Drag / wheel | Orbit / zoom (Shift + drag pans) |
| Space | Run or hold the current step's action |
| ← → | Previous / next step |
| V | Swap big view and loupe |
| 1 · 2 · 3 | Specimen camera: 3D · Section · Top |
| G · S | Guided · Sandbox |
| Double-click a slider | Reset to nominal |

## Code map

```
src/
  core/      params (sources, ranges, constants), stages (guided script), store
  sim/       patterns (mask layouts), blur (periodic ops), engine (optics → resist → etch
             → metrics → process window → wafer map), controller (textures, caching)
  scene/     OrbitRig (cinematic camera), fx (beams, particles)
    tool/    ToolScene, Scanner, Stations, Wafer (thin-film interference shader)
    micro/   MicroScene (GPU heightfield relief + cross-section faces)
  render/    Viewport (renderer, bloom, grading)
  ui/        Controls, Narration, Analysis, charts, Chrome (top bar, timeline, loupe), Labels
  i18n/      t() / nf() helpers and the EN + PT dictionaries (all user-facing copy)
```

`window.litho` exposes the app instance in the console (e.g. `litho.sim.metrics`).
