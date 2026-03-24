/**
 * app.js — Main orchestration: serial input, buffer management,
 *          Edge Impulse model adapter, and UI updates.
 *
 * Dependencies (loaded before this script):
 *   • model/edge-impulse-standalone.js  – Edge Impulse WASM module (sets global Module)
 *   • model/run-impulse.js              – EdgeImpulseClassifier class
 *   • hardcode.js                       – classifyHardcode()
 *   • chart.js                          – chartPush(), chartClear()
 */

// ── Configuration ──────────────────────────────────────────────────

const BAUD_RATE       = 115200;
const EXPECTED_FRAMES = 9;   // 5 Hz × 1.8 s window = 9 frames
const AXES_PER_FRAME  = 2;   // raw, delta
const MODEL_INPUT_LEN = EXPECTED_FRAMES * AXES_PER_FRAME; // 18

// ── State ──────────────────────────────────────────────────────────

let port          = null;   // Web Serial port
let reader        = null;   // ReadableStream reader
let keepReading   = false;
let lineBuf       = '';     // partial line accumulator

/** Rolling buffer of frames: { raw, delta, ts } */
let frames = [];

/** Edge Impulse classifier instance (created once, reused). */
let classifier = null;
let modelReady = false;

/** Last combined label string used for dedup in event log. */
let lastLogEntry = '';

// ── DOM references ─────────────────────────────────────────────────

const elStatus      = document.getElementById('status');
const elHcLabel     = document.getElementById('hc-label');
const elHcDebug     = document.getElementById('hc-debug');
const elMlLabel     = document.getElementById('ml-label');
const elMlDebug     = document.getElementById('ml-debug');
const elSensorRaw   = document.getElementById('sensor-raw');
const elSensorDelta = document.getElementById('sensor-delta');
const elSensorFrames= document.getElementById('sensor-frames');
const elEventLog    = document.getElementById('event-log');

// ── Initialise Edge Impulse model ─────────────────────────────────

/**
 * Load the Edge Impulse WASM model.
 *
 * This relies on the global EdgeImpulseClassifier class defined in
 * model/run-impulse.js and the WASM module loaded by
 * model/edge-impulse-standalone.js.
 *
 * If the export wrapper API changes in a future Edge Impulse version,
 * update the calls below accordingly.
 */
async function loadModel() {
  try {
    classifier = new EdgeImpulseClassifier();
    await classifier.init();
    modelReady = true;

    const project = classifier.getProjectInfo();
    console.log('Edge Impulse model loaded:', project);
    elMlDebug.textContent = `${project.owner} / ${project.name} v${project.deploy_version}`;
  } catch (err) {
    console.error('Failed to load Edge Impulse model:', err);
    elMlLabel.textContent = 'load error';
    elMlDebug.textContent = String(err);
  }
}

// Kick off model loading immediately (non-blocking).
loadModel();

// ── Edge Impulse inference adapter ────────────────────────────────

/**
 * Flatten the rolling frame buffer to the numeric array expected by
 * the Edge Impulse classifier.
 *
 * Order: [raw1, delta1, raw2, delta2, …]
 *
 * @param {Array<{raw:number, delta:number}>} buf
 * @returns {number[]}
 */
function flattenFrames(buf) {
  const out = [];
  for (const f of buf) {
    out.push(f.raw, f.delta);
  }
  return out;
}

/**
 * Run inference on the current frame buffer using the Edge Impulse model.
 *
 * Returns { label, score, debug } or null if the model is not ready
 * or the buffer is not full.
 *
 * NOTE: If your Edge Impulse export exposes a different API (e.g.
 * classifyContinuous), swap out the classify() call here.
 */
function runModelInference() {
  if (!modelReady)                    return null;
  if (frames.length < EXPECTED_FRAMES) return null;

  const input = flattenFrames(frames);

  if (input.length !== MODEL_INPUT_LEN) {
    console.warn(`Model input length mismatch: got ${input.length}, expected ${MODEL_INPUT_LEN}`);
    return null;
  }

  try {
    const result = classifier.classify(input);

    // result.results is an array of { label, value }.
    // Pick the label with the highest score.
    let bestLabel = '?';
    let bestScore = -1;
    for (const r of result.results) {
      if (r.value > bestScore) {
        bestScore = r.value;
        bestLabel = r.label;
      }
    }

    const debug = result.results
      .map(r => `${r.label}: ${(r.value * 100).toFixed(1)}%`)
      .join('  ');

    return { label: bestLabel, score: bestScore, debug };
  } catch (err) {
    console.error('Inference error:', err);
    return { label: 'error', score: 0, debug: String(err) };
  }
}

// ── Serial communication (Web Serial API) ─────────────────────────

document.getElementById('btn-connect').addEventListener('click', toggleSerial);
document.getElementById('btn-clear').addEventListener('click', clearBuffers);

async function toggleSerial() {
  if (port) {
    await disconnectSerial();
  } else {
    await connectSerial();
  }
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    setStatus('error');
    alert('Web Serial API is not available.\nUse Chromium or Google Chrome and ensure the page is served over localhost or HTTPS.');
    return;
  }

  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: BAUD_RATE });
    setStatus('connected');
    keepReading = true;
    readLoop();
  } catch (err) {
    console.error('Serial connect error:', err);
    setStatus('error');
    port = null;
  }
}

async function disconnectSerial() {
  keepReading = false;
  try {
    if (reader) {
      await reader.cancel();
      reader = null;
    }
    if (port) {
      await port.close();
    }
  } catch (err) {
    console.warn('Serial disconnect error:', err);
  }
  port = null;
  setStatus('disconnected');
}

/**
 * Continuously read from the serial port, splitting on newlines.
 * Each complete line is forwarded to handleLine().
 */
async function readLoop() {
  const decoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(decoder.writable);
  reader = decoder.readable.getReader();

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        lineBuf += value;
        const parts = lineBuf.split('\n');
        // Last element is either '' (complete line) or a partial.
        lineBuf = parts.pop();
        for (const line of parts) {
          handleLine(line.trim());
        }
      }
    }
  } catch (err) {
    if (keepReading) {
      console.error('Serial read error:', err);
      setStatus('error');
    }
  } finally {
    reader = null;
    try { await readableStreamClosed; } catch (_) { /* ignore */ }
  }
}

// ── Line parsing & processing ─────────────────────────────────────

/**
 * Parse one serial line in the format "raw,delta".
 * Ignore any line that doesn't match.
 */
function handleLine(line) {
  if (!line) return;
  const parts = line.split(',');
  if (parts.length !== 2) return;

  const raw   = Number(parts[0]);
  const delta = Number(parts[1]);
  if (Number.isNaN(raw) || Number.isNaN(delta)) return;

  // Add frame to rolling buffer
  frames.push({ raw, delta, ts: Date.now() });
  if (frames.length > EXPECTED_FRAMES) {
    frames.shift();
  }

  // Update sensor info
  elSensorRaw.textContent   = raw;
  elSensorDelta.textContent = delta;
  elSensorFrames.textContent = frames.length;

  // Gram display (if weight-calibrated)
  const grams = rawToGrams(raw);
  const elGrams = document.getElementById('sensor-grams');
  elGrams.textContent = grams != null ? grams.toFixed(1) + ' g' : '—';

  // Update chart
  chartPush(raw, delta);

  // Run both classifiers
  runClassifiers();
}

// ── Classification orchestration ──────────────────────────────────

let lastHcLabel = '';
let lastMlLabel = '';

// ML stabilisation: require N consecutive identical non-idle labels
const ML_CONFIRM_FRAMES = 5;   // ~1 s at 5 Hz
let mlCandidateLabel = '';
let mlCandidateCount = 0;
let mlConfirmedLabel = '';      // last label that was actually counted

function runClassifiers() {
  // 1. Hardcoded classifier
  const hc = classifyHardcode(frames);
  elHcLabel.textContent = hc.label;
  elHcDebug.textContent = hc.debug;

  // HC bottle count — dedup per classifier
  if (hc.label !== lastHcLabel) {
    lastHcLabel = hc.label;
    applyBottleEvent('hc', hc.label, hc);
  }

  // 2. ML model
  const ml = runModelInference();
  if (ml) {
    elMlLabel.textContent = ml.label;
    elMlDebug.textContent = ml.debug;

    // ML bottle count — stabilised: only count after N consecutive same frames
    if (ml.label === mlCandidateLabel) {
      mlCandidateCount++;
    } else {
      mlCandidateLabel = ml.label;
      mlCandidateCount = 1;
    }

    if (mlCandidateCount >= ML_CONFIRM_FRAMES && mlCandidateLabel !== mlConfirmedLabel) {
      mlConfirmedLabel = mlCandidateLabel;
      applyBottleEvent('ml', mlConfirmedLabel);
    }
  }

  // 3. Event log (deduplicate consecutive identical combined entries)
  const mlLabel = ml ? ml.label : '…';
  const entry   = `hardcode=${hc.label}, ml=${mlLabel}`;
  if (entry !== lastLogEntry) {
    lastLogEntry = entry;
    addLogEntry(entry);
  }
}

// ── Event log ─────────────────────────────────────────────────────

const MAX_LOG = 200;

function addLogEntry(text) {
  const ts = new Date().toLocaleTimeString();
  const li = document.createElement('li');
  li.textContent = `[${ts}] ${text}`;
  elEventLog.prepend(li);

  // Trim old entries
  while (elEventLog.children.length > MAX_LOG) {
    elEventLog.removeChild(elEventLog.lastChild);
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function clearBuffers() {
  frames = [];
  lineBuf = '';
  lastLogEntry = '';
  lastHcLabel = '';
  lastMlLabel = '';
  mlCandidateLabel = '';
  mlCandidateCount = 0;
  mlConfirmedLabel = '';
  elSensorRaw.textContent   = '—';
  elSensorDelta.textContent = '—';
  elSensorFrames.textContent = '0';
  elHcLabel.textContent = '—';
  elHcDebug.textContent = '';
  elMlLabel.textContent = '—';
  elMlDebug.textContent = '';
  elEventLog.innerHTML  = '';
  resetBottles('hc');
  resetBottles('ml');
  chartClear();
  console.log('Buffers cleared.');
}

function setStatus(state) {
  elStatus.textContent = state;
  elStatus.className   = 'status ' + state;
}

// ── Bottle counters (one per classifier) ──────────────────────────

const bottles = {
  hc: { full: 0, empty: 0 },
  ml: { full: 0, empty: 0 },
};

const bottleEls = {
  hc: { total: document.getElementById('hc-total'), full: document.getElementById('hc-full'), empty: document.getElementById('hc-empty') },
  ml: { total: document.getElementById('ml-total'), full: document.getElementById('ml-full'), empty: document.getElementById('ml-empty') },
};

function updateBottleUI(who) {
  const b  = bottles[who];
  const el = bottleEls[who];
  el.total.textContent = b.full + b.empty;
  el.full.textContent  = b.full;
  el.empty.textContent = b.empty;
}

function resetBottles(who) {
  bottles[who].full = 0;
  bottles[who].empty = 0;
  updateBottleUI(who);
}

document.getElementById('hc-reset').addEventListener('click', () => resetBottles('hc'));
document.getElementById('ml-reset').addEventListener('click', () => resetBottles('ml'));

/** Expose current HC crate state for the classifier. */
function getHcCrateState() {
  return { full: bottles.hc.full, empty: bottles.hc.empty };
}

/**
 * Update bottle count for a specific classifier.
 * Supports multi-bottle changes via fullDelta / emptyDelta on the result.
 * @param {'hc'|'ml'} who
 * @param {string} label  display label
 * @param {object} [result]  optional { fullDelta, emptyDelta }
 */
function applyBottleEvent(who, label, result) {
  const b = bottles[who];

  if (result && result.resetFull != null) {
    // Full recalculation from absolute weight
    b.full  = result.resetFull;
    b.empty = result.resetEmpty;
    updateBottleUI(who);
    return;
  }

  if (result && (result.fullDelta || result.emptyDelta)) {
    // Multi-bottle path
    b.full  = Math.max(0, b.full  + (result.fullDelta  || 0));
    b.empty = Math.max(0, b.empty + (result.emptyDelta || 0));
    updateBottleUI(who);
    return;
  }

  // Legacy single-bottle path (ML model)
  if (label === 'put_full')      { b.full++;  updateBottleUI(who); }
  if (label === 'put_empty')     { b.empty++; updateBottleUI(who); }
  if (label === 'remove_full')   { b.full  = Math.max(0, b.full  - 1); updateBottleUI(who); }
  if (label === 'remove_empty')  { b.empty = Math.max(0, b.empty - 1); updateBottleUI(who); }
}

// ── Calibration UI ────────────────────────────────────────────────

const elCalStatus    = document.getElementById('cal-status');
const elCalTbody     = document.getElementById('cal-tbody');
const elCalCountdown = document.getElementById('cal-countdown');

const CAL_LABEL_MAP = {
  idle:         'Leerer Kasten',
  put_full:     'Volle Flasche rein',
  put_empty:    'Leere Flasche rein',
};

let calTimer = null; // active countdown interval

function renderCalibrationUI() {
  const count = calibrationCount();
  if (count === 0) {
    elCalStatus.textContent = 'nicht kalibriert';
    elCalStatus.className = 'cal-badge';
  } else if (isFullyCalibrated()) {
    elCalStatus.textContent = 'bereit';
    elCalStatus.className = 'cal-badge ready';
  } else {
    elCalStatus.textContent = `${count}/${CAL_ACTIONS.length}`;
    elCalStatus.className = 'cal-badge partial';
  }

  // Table
  elCalTbody.innerHTML = '';
  for (const action of CAL_ACTIONS) {
    const tr = document.createElement('tr');
    const ref = calibration[action];
    const label = CAL_LABEL_MAP[action] || action;
    if (ref) {
      const grams = isWeightCalibrated() ? diffToGrams(ref.diff) : null;
      const gStr  = grams != null ? Math.abs(grams).toFixed(0) + ' g' : '—';
      tr.innerHTML =
        `<td>${label}</td>` +
        `<td>${ref.diff.toFixed(0)}</td>` +
        `<td>${ref.sd.toFixed(0)}</td>` +
        `<td>${gStr}</td>` +
        `<td>${new Date(ref.ts).toLocaleTimeString()}</td>`;
    } else {
      tr.innerHTML = `<td>${label}</td><td colspan="4" style="color:#666">—</td>`;
    }
    elCalTbody.appendChild(tr);
  }

  // Bottle weight summary
  const elBottleWeights = document.getElementById('cal-bottle-weights');
  const bw = getBottleWeightsGrams();
  if (bw) {
    let txt = `🍺 Volle Flasche ≈ ${bw.fullGrams.toFixed(0)} g`;
    if (bw.emptyGrams != null) txt += `  ·  🍾 Leere Flasche ≈ ${bw.emptyGrams.toFixed(0)} g`;
    elBottleWeights.textContent = txt;
  } else {
    elBottleWeights.textContent = '';
  }

  // Highlight captured buttons via data-captured attribute
  for (const [action, btnId] of Object.entries(CAL_BTN_MAP)) {
    const btn = document.getElementById(btnId);
    if (btn) btn.classList.toggle('captured', !!calibration[action]);
  }
}

// Map calibration action → button id
const CAL_BTN_MAP = {
  idle:         'cal-idle',
  put_full:     'cal-put-full',
  put_empty:    'cal-put-empty',
};

/** Mean of the last N raw values from the rolling buffer. */
function currentRawMean(n) {
  const slice = frames.slice(-n).map(f => f.raw);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/**
 * Start a timed capture.
 * Records startMean from tare (idle.endMean) if available, otherwise from
 * current sensor value. After countdown, compares to tare.
 */
function startTimedCapture(action, seconds) {
  if (calTimer) { clearInterval(calTimer); calTimer = null; }

  const label = CAL_LABEL_MAP[action] || action;
  if (frames.length < 3) {
    elCalCountdown.textContent = `Nicht genug Daten. Erst Serial verbinden.`;
    return;
  }

  // Use tare (idle) as reference if available, otherwise current value
  const tareRaw = calibration['idle'] ? calibration['idle'].endMean : currentRawMean(5);
  let remaining = seconds;
  elCalCountdown.textContent = `${label}: ${remaining} s — jetzt Aktion ausführen!`;

  calTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      elCalCountdown.textContent = `${label}: ${remaining} s …`;
    } else {
      clearInterval(calTimer);
      calTimer = null;
      if (frames.length < 3) {
        elCalCountdown.textContent = `Nicht genug Daten. Nochmal versuchen.`;
        return;
      }
      const endMean = currentRawMean(5);
      const sd      = stddev(frames.slice(-5).map(f => f.raw));
      const result  = captureCalibration(action, tareRaw, endMean, sd);
      const grams   = isWeightCalibrated() ? diffToGrams(result.diff) : null;
      const gStr    = grams != null ? `  (${Math.abs(grams).toFixed(0)} g)` : '';
      elCalCountdown.textContent = `✓ ${label} kalibriert!  Δraw=${result.diff.toFixed(0)}${gStr}`;
      console.log(`Calibration captured [${action}]:`, result);
      renderCalibrationUI();
    }
  }, 1000);
}

/**
 * Immediate capture — used for "idle" / empty crate.
 * Captures current sensor state (startMean ≈ endMean, diff ≈ 0).
 */
function captureNow(action) {
  if (calTimer) { clearInterval(calTimer); calTimer = null; }
  const label = CAL_LABEL_MAP[action] || action;
  if (frames.length < 3) {
    elCalCountdown.textContent = `Nicht genug Daten. Warte auf Daten.`;
    return;
  }
  const rawMean = currentRawMean(5);
  const sd      = stddev(frames.slice(-5).map(f => f.raw));
  const result  = captureCalibration(action, rawMean, rawMean, sd);
  elCalCountdown.textContent = `✓ ${label} kalibriert!  mean=${rawMean.toFixed(0)}`;
  console.log(`Calibration captured [${action}]:`, result);
  renderCalibrationUI();
}

// Button event listeners
document.getElementById('cal-idle').addEventListener('click',         () => captureNow('idle'));
document.getElementById('cal-put-full').addEventListener('click',     () => startTimedCapture('put_full', 5));
document.getElementById('cal-put-empty').addEventListener('click',    () => startTimedCapture('put_empty', 5));

document.getElementById('btn-cal-clear').addEventListener('click', () => {
  if (calTimer) { clearInterval(calTimer); calTimer = null; }
  clearCalibration();
  localStorage.removeItem('weight_calibration');
  elCalCountdown.textContent = '';
  renderCalibrationUI();
  console.log('Calibration cleared.');
});

// Initial render (restores calibration from localStorage)
renderCalibrationUI();

// Crate capacity input
const elCrateCap = document.getElementById('cal-crate-cap');
elCrateCap.value = getCrateCapacity();
elCrateCap.addEventListener('change', () => {
  const v = parseInt(elCrateCap.value, 10);
  if (v >= 1) setCrateCapacity(v);
  elCrateCap.value = getCrateCapacity();
});
