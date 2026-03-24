# ML vs Hardcode Demo

> Browser-based side-by-side comparison of an **Edge Impulse WebAssembly
> model** and a **hardcoded rule-based classifier**, both receiving the
> same live serial sensor stream from an Arduino / ESP32 with a load cell.

---

## What this project does

This demo connects to an Arduino over USB serial **directly from the
browser** (using the Web Serial API).  Every incoming sensor line is fed
to two classifiers in parallel:

| Classifier | Description |
|---|---|
| **Hardcoded** | Deterministic rules in `public/hardcode.js` — compares start/end means, standard deviation, and fixed thresholds. |
| **Edge Impulse ML** | Runs the exported WASM model locally in the browser — no cloud calls. |

The UI shows both results side by side, along with live charts and an
event log, so you can compare accuracy in real time.

---

## Expected serial input format

The Arduino must send **one line per sample** at **115200 baud**:

```
raw,delta
```

Example:

```
-1246970,-268
-1246742,228
-1078290,168452
```

- **raw** — the current load cell reading (integer)
- **delta** — difference to the previous reading (integer)
- 2 axes, matching the Edge Impulse project configuration

---

## Model parameters

| Parameter       | Value |
|-----------------|-------|
| Frequency       | 5 Hz  |
| Window size     | 1800 ms |
| Frames per window | **9** (5 × 1.8) |
| Values per frame  | 2 (raw, delta) |
| **Total model input** | **18 numeric values** |

The flattened input order is:
`[raw₁, delta₁, raw₂, delta₂, … , raw₉, delta₉]`

---

## Prerequisites

- **Node.js** ≥ 16
- **Chromium-based browser** (Chrome, Chromium, Edge).  
  Web Serial is **not** available in Firefox or Safari.
- Arduino / ESP32 connected via USB, streaming lines as described above.

---

## Installation

```bash
cd ml-vs-hardcode-demo
npm install
```

---

## Running

```bash
npm start
```

Then open **http://localhost:3000** in Chromium.

1. Click **Connect serial** and select the Arduino's serial port.
2. Both classifier cards will start updating live.

---

## Edge Impulse WASM export files

The model files live in `public/model/`.  
See [`public/model/MODEL_README.md`](public/model/MODEL_README.md) for details.

**Quick steps:**

1. Edge Impulse Studio → **Deployment** → **WebAssembly (browser / SIMD)** → **Build**.
2. Download and extract the ZIP.
3. Copy these three files into `public/model/`:
   - `edge-impulse-standalone.js`
   - `edge-impulse-standalone.wasm`
   - `run-impulse.js`

If the exported wrapper API differs from the current one, adjust the
model adapter section in `public/app.js` (search for
`runModelInference`).

---

## Hardcoded classifier thresholds

The thresholds in `public/hardcode.js` are **placeholders**.  
Run the demo, look at the debug values printed in the "Hardcoded
Classifier" card, and tune the constants (`IDLE_DIFF_THRESHOLD`,
`PUT_DIFF_THRESHOLD`, etc.) to match your real sensor behaviour.

---

## Relationship to `edge-impulse-data-forwarder`

You may currently be using:

```bash
edge-impulse-data-forwarder --clean --baud-rate 115200 --frequency 5
```

That command streams data **to** the Edge Impulse cloud for data
collection and training.

This demo app is **separate** — it reads the serial stream **directly
in the browser** via Web Serial and performs inference locally with the
exported WASM model.  The data forwarder and this demo **cannot** use
the serial port at the same time; close the forwarder before starting
the demo.

---

## Project structure

```
ml-vs-hardcode-demo/
├── package.json
├── server.js              ← Express static file server (port 3000)
├── .gitignore
├── README.md              ← this file
└── public/
    ├── index.html         ← main UI
    ├── styles.css
    ├── app.js             ← serial input, model adapter, orchestration
    ├── hardcode.js        ← rule-based classifier
    ├── chart.js           ← rolling canvas chart
    └── model/
        ├── MODEL_README.md
        ├── edge-impulse-standalone.js
        ├── edge-impulse-standalone.wasm
        └── run-impulse.js
```

---

## License

MIT
