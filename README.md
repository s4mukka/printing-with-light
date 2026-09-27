# Printing with Light

### A case study in building a 3D interactive exhibit end-to-end with Claude

**[Live demo → s4mukka.github.io/printing-with-light](https://s4mukka.github.io/printing-with-light/)** · English / Português (BR)

This repository is an experiment in how far an AI agent can carry a creative-technology project on its own.
**Claude** (Anthropic's Claude Opus 5.5, working as an agent in Claude Code) was handed one open-ended brief —
*build a museum-grade, interactive 3D experience that teaches semiconductor photolithography* — and then
designed, wrote, ran, inspected and refined the entire application.

Photolithography is the vehicle. The subject of the study is the process: what an LLM does when it is asked
not just to write code, but to make something that *looks and feels finished*.

---

## At a glance

| | |
|---|---|
| **Human input** | One creative brief, plus a few follow-up messages (a Portuguese translation, one bug report, hosting, repository setup, this README) |
| **Code written by a human** | None |
| **Output** | ~8,700 lines of TypeScript, GLSL and CSS in 30 source files |
| **Assets** | None — every model, material, particle and chart is procedural |
| **Dependencies** | `three` plus three self-hosted font packages |
| **Stack (chosen by Claude)** | Vite · TypeScript · Three.js / WebGL · custom shaders |
| **Verification** | Type-checking, production builds, and visual review in an embedded browser at laptop-to-desktop viewport sizes |

## The brief

The request asked for the opposite of a typical generated web page. Paraphrased:

- **Interaction first.** People should learn by manipulating a simulation, not by reading. *"The simulation itself is the explanation."*
- **A real 3D scene** — light source, optics, photomask, wafer, photoresist — and all nine process steps, from wafer preparation to the final patterned wafer.
- **Ten live parameters** (wavelength, dose, focus, alignment, mask pattern, resist thickness and tone, development time, etch depth), each with an immediate, visible effect.
- **Make the invisible visible:** light rays, pattern transfer, overlay error, blur, cross-sections, defect maps, a critical-dimension read-out, a yield indicator.
- **Two modes:** a narrated guided tour for complete beginners and a sandbox for exploring trade-offs and failure modes.
- **A quality bar:** cinematic, tactile, "made by an experienced creative technologist" — and, crucially:
  *run the application, inspect it visually, identify weak areas, and iterate until it feels finished.*

## How Claude worked

**1 · Architecture before pixels.** Claude split the project into a simulation core with no rendering knowledge
(`sim/`), a thin controller that turns results into GPU textures, two independent 3D scenes (a fab bench and a
microscope specimen, swappable between the main view and a circular loupe) and a DOM layer for type and controls.

**2 · Numbers drive the visuals.** Instead of scripting animations, Claude built a simplified but physically structured
model — optical blur from λ/NA, defocus per depth slice, resist absorption, photon shot noise, a dissolution-rate
development model, a Dijkstra development front for cross-sections, etch selectivity, a dose × focus process window and a
per-die yield map. Every image on screen is a rendering of those numbers, so fixing a metric also fixes the picture.

**3 · Build, then look.** Claude ran the dev server inside the Claude desktop app's built-in browser, emulated
1280×720, 1440×900 and 1920×1080 viewports, took screenshots and read them. To make that practical it instrumented its own
app: the instance is exposed as `window.litho`, and `litho.advance(seconds)` fast-forwards the render loop deterministically,
so any step of the tour can be reached and captured in one command even when the browser pane is not painting.

**4 · Iterate on what it saw.** The first working version was a long way from the final one. The loop below is where
most of the quality came from.

## What the iteration loop caught

| What Claude saw | Root cause it found | Fix |
|---|---|---|
| The first render looked like an untextured clay model | Over-bright lights and panel albedo | Rebalanced lighting and materials; added amber "yellow-room" accents |
| Sliders stuttered; one recompute took **364 ms** | The process-window sweep re-ran the full resist model for every cell | Lookup tables and O(N) blurs → **17 ms**; development 11 → 6 ms, cross-section 17 → 4 ms |
| CD read-out and process window jumped in 6–12 % steps | Edges measured on a pixel-thresholded field | Sub-pixel edge detection on the continuous exposure field |
| Film and silicon looked identical in the cross-section | sRGB colours fed to a custom shader as linear values | Diagnosed by temporarily rendering material IDs as RGB; palette moved to linear space |
| Station name plates were invisible | A rounded-box helper grew every mesh by its bevel, burying the plates inside the bench | Fixed the geometry helper |
| Labels drawn hundreds of pixels from their anchors | A CSS class (`.left`) collided with the layout column's class | Renamed the label classes |
| The *nominal* process yielded 0 % | Dose-to-size was 26 instead of 30, and a residue metric counted pixels next to every edge | Calibrated the resist model; restricted the metric to the interior of openings |
| Negative resist needed 88 mJ/cm², off the slider | One sensitivity for both resist tones | Separately calibrated negative-tone chemistry |
| Flipping the resist tone seemed to do nothing | 50/50 lines and spaces look the same when inverted | Guided tour uses a logic layout where wires visibly become trenches |
| Frame budget on an Intel UHD integrated GPU | Glass rendered with a transmission pass that re-draws the scene | Cheaper glass, adaptive resolution, loupe at 30 fps, fewer texture uploads |

## Where the human still mattered

- **A bug the automated checks missed.** On the title screen the EN/PT switch looked fine but ignored clicks: an invisible
  overlay sat on top of it. Claude's own tests had used programmatic `.click()`, which bypasses hit-testing. The human found it
  by actually using the page; Claude then fixed it and re-tested with real mouse and keyboard input.
- **Direction and taste.** Adding Brazilian Portuguese, choosing where to host, publishing, and using a personal e-mail for commits
  were human decisions. Claude flagged the decisions it made on its own (such as UI terminology) so they could be reviewed.
- **Things Claude could not verify.** The real frame rate (the embedded browser throttles rendering while hidden), the spoken
  narration audio, and phone layouts beyond CSS rules.

## Takeaways

- **Visual self-review is the multiplier.** The first draft compiled and ran; the finished piece came from reading screenshots and
  going back to the code, many times.
- **Make the app observable for the agent.** Deterministic time-stepping and exposed state turned "look at the app" into a
  repeatable test.
- **Model first, pixels second.** Because a simulation drives the scene, correctness work and visual work reinforced each other.
- **Keep a human on the controls.** An agent's checks are only as good as the input they simulate; ten seconds of real use found
  what scripted clicks could not.

---

## The exhibit

- **Guided** — nine narrated steps (clean, coat, soft bake, align, expose, post-exposure bake, develop, etch, inspect), each with one
  idea, one thing to do and one insight. Optional voice narration.
- **Sandbox** — every parameter live, with CD, edge roughness, dose-to-size, wafer yield, the aerial image, the process window,
  seven failure-mode lamps and "break it on purpose" presets.
- **Fab bench** — coater, hot plate, a cut-away scanner that shows diffraction orders passing (or missing) the lens pupil, a
  plasma etcher and an inspection ring with the wafer yield map.
- **Specimen** — a true-scale 3D relief of resist on film on silicon, with a movable cross-section, a design-vs-printed overlay and
  an aerial-image heat map.

The physics is deliberately simplified and the numbers are illustrative, but the scaling laws are the real ones: resolution ∝ λ/NA,
depth of focus ∝ λ/NA², shot noise ∝ 1/√(dose·λ).

### Controls

| Input | Action |
|---|---|
| Drag / wheel | Orbit / zoom (Shift + drag pans) |
| Space | Run or hold the current step's action |
| ← → | Previous / next step |
| V | Swap the main view and the loupe |
| 1 · 2 · 3 | Specimen camera: 3D · Section · Top |
| Double-click a slider | Reset it to nominal |

## Run locally

```bash
npm install
npm run dev        # http://127.0.0.1:5178
```

```bash
npm run build      # static build in dist/ (relative paths, works under any sub-path)
npm run preview
```

Append `?stats` to the URL for a frame-time and resolution read-out.

## Deploy

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every push to `main`
(repository **Settings → Pages → Source: GitHub Actions**).

## Code map

```
src/
  core/      parameters and constants, the nine-step choreography, app state
  sim/       mask layouts, periodic image ops, the lithography engine, GPU texture controller
  scene/     cinematic orbit camera, light beams and particles
    tool/    fab bench, scanner, stations, wafer (thin-film interference shader)
    micro/   specimen relief and cross-section faces
  render/    renderer, bloom and colour grading
  ui/        controls, narration, analysis, charts, chrome, 3D labels
  i18n/      translation helpers and the English + Portuguese dictionaries
```

---

Built by Claude (Anthropic) under the direction of [Samuel Pereira](https://github.com/s4mukka).
An independent study; not affiliated with Anthropic or any semiconductor manufacturer.
