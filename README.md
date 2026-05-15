# CoilCalc — Web edition

[![GitHub Pages](https://img.shields.io/badge/live-bynarical.github.io%2FMR--WPT__Coil__Calculator--Web-blue?logo=github)](https://bynarical.github.io/MR-WPT_Coil_Calculator-Web/)

Browser-hosted **magnetic-resonance wireless power transfer (MR-WPT) coil
calculator**. Runs entirely in your browser — no server, no backend, no
data leaves your machine.

> Greetings from Seoul.

## What is this?

A pre-built, runnable snapshot of [CoilCalc](https://github.com/BYnarical/MR-WPT_Coil_Calculator).
The Python physics core is shipped as a pure-Python wheel and executed
inside the page by [Pyodide](https://pyodide.org) (CPython compiled to
WebAssembly). First visit downloads ~30 MB; subsequent visits load
instantly from your browser's cache.

**This repository is the runnable site only. For the full source code,
tests, desktop builds, and Electron build, see
[BYnarical/MR-WPT_Coil_Calculator](https://github.com/BYnarical/MR-WPT_Coil_Calculator).**

## Live site

→ **https://bynarical.github.io/MR-WPT_Coil_Calculator-Web/**

## Run locally

```bash
git clone https://github.com/BYnarical/MR-WPT_Coil_Calculator-Web
cd MR-WPT_Coil_Calculator-Web
python -m http.server 5173
# → http://localhost:5173
```

Any static file server works: `npx serve .`, `caddy file-server`,
nginx, S3, Netlify, Cloudflare Pages — even `file://` in a browser
that allows local module imports.

## What's in here

| File | Size | Purpose |
|---|---|---|
| `index.html`               | 11 KB | UI shell with 4 tabs |
| `style.css`                | 6.5 KB | Material-style dark theme |
| `app.js`                   | 19 KB | Tab logic + Three.js (3-D coil view) + Chart.js (sweep plots) |
| `pyodide-bridge.js`        | 2.8 KB | Loads Pyodide CDN, installs the wheel, exposes `compute(method, params)` |
| `coilcalc-0.6.0-py3-none-any.whl` | 67 KB | The Python physics package |

## Tabs

| Tab | Live |
|---|---|
| **Single coil** | Pick geometry + conductor + frequency → live `L`, `R_dc`, `R_ac`, `Q`, `SRF`, wire length, interactive 3-D filament view |
| **Pair / coupling** | Tx + Rx geometry, alignment (gap, lateral, tilt), R_load, V_source, frequency → live `M`, `k`, `η`, `V_out`, `P_in`, `P_load` + three sweep plots (k-vs-gap, k-vs-lateral, η-vs-gap) |
| **System (N-coil)** | Editable table of N coils + 3-D positions → live `η`, `V_out`, gain, P_in, P_load, 3-D layout view, ‖k‖ coupling-matrix heatmap |
| **About** | Models summary |

## Physics coverage

| Quantity | Method |
|---|---|
| Self-inductance L | Mohan current-sheet, Wheeler-Nagaoka, Zhao multi-layer, universal Neumann + GMR |
| Mutual inductance M | Maxwell coaxial closed-form, universal Neumann numerical |
| AC resistance R_ac | Bessel/Kelvin (round), Sullivan (Litz), Dowell (foil), Yue (PCB trace) |
| External proximity | Biot-Savart `⟨H/I⟩²` along filament + Ferreira/Sullivan coefficient |
| Self-resonance SRF | Medhurst (solenoid), GKMR + Yun (spiral) |
| N-coil link η | Full Z-matrix series-resonant solver |

Validated against published theory (Nagaoka 1909, Mohan et al. JSSC 1999,
Wheeler 1928, Maxwell, Bessel-skin) — 26 / 26 analytical theory checks
pass. The source repository runs 41 pytest cases on every push.

## License

Same as the source repository — MIT.

— © 2026 Bynarical
