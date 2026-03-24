# Edge Impulse WASM Browser Export

This directory should contain the following files from an
Edge Impulse **Deployment → WebAssembly (browser)** export:

| File                            | Purpose                          |
|---------------------------------|----------------------------------|
| `edge-impulse-standalone.js`    | JS glue code that loads the WASM |
| `edge-impulse-standalone.wasm`  | Compiled model binary            |
| `run-impulse.js`                | `EdgeImpulseClassifier` class    |

## How to obtain these files

1. Go to your Edge Impulse project → **Deployment**.
2. Choose **WebAssembly** → **Browser (WASM + SIMD)**.
3. Click **Build** and download the ZIP.
4. Extract the ZIP and copy the three files listed above into this
   directory (`public/model/`).

> The `index.html` and `server.py` that come with the export are not
> needed — our own `public/index.html` replaces them.

## Notes

- The demo's `app.js` expects the `EdgeImpulseClassifier` class to be
  available globally after loading `run-impulse.js`.
- If a future Edge Impulse export changes the API (method names,
  constructor, etc.) you will need to adjust `app.js` accordingly.
