/**
 * hardcode.js — Deterministic rule-based classifier with calibration support.
 *
 * Receives a rolling buffer of frames: { raw, delta, ts }
 * Returns: { label: string, debug: string }
 *
 * CALIBRATION WORKFLOW:
 *   1. "idle"         → empty crate sitting still on the load cell
 *   2. "put_full"     → user places a full bottle (captured after 5 s countdown)
 *   3. "put_empty"    → user places an empty bottle (captured after 5 s countdown)
 *   4. "remove_full"  → user removes a full bottle
 *   5. "remove_empty" → user removes an empty bottle
 *
 *   Each capture stores { diff, sd, endMean, ts }.
 *   The classifier uses nearest-neighbour matching when at least 2 captures exist.
 *
 * Calibration is persisted in localStorage.
 */

// ── Constants ───────────────────────────────────────────────────────

const MIN_FRAMES        = 9;

// State machine thresholds (adaptive if idle calibration exists)
const DEFAULT_CALM_SD   = 500;     // sd below → calm
const DEFAULT_MOVE_SD   = 5000;    // sd above → moving
const SETTLE_FRAMES     = 8;       // ~1.6 s at 5 Hz
const WEIGHT_TOLERANCE  = 0.35;    // 35 % tolerance for bottle weight matching
const DISPLAY_HOLD      = 15;      // hold confirmed label for this many frames

// ── State machine ───────────────────────────────────────────────────

let hcState        = 'stable';   // 'stable' | 'changing' | 'settling'
let stableBaseline = null;       // raw value when sensor was last stable
let calmCounter    = 0;          // consecutive calm frames in settling
let confirmedLabel = 'idle';     // last confirmed classification
let displayCounter = 0;          // frames to hold confirmed label on screen

// ── Crate capacity ─────────────────────────────────────────────────

const CRATE_CAP_KEY = 'crate_capacity';
let crateCapacity = Number(localStorage.getItem(CRATE_CAP_KEY)) || 4;

function setCrateCapacity(n) {
  crateCapacity = Math.max(1, Math.floor(n));
  localStorage.setItem(CRATE_CAP_KEY, crateCapacity);
}

function getCrateCapacity() { return crateCapacity; }

// ── Calibration storage ─────────────────────────────────────────────

const CAL_STORAGE_KEY = 'hc_calibration';
const CAL_ACTIONS     = ['idle', 'put_full', 'put_empty'];

let calibration = loadCalibration();

function loadCalibration() {
  try {
    const data = JSON.parse(localStorage.getItem(CAL_STORAGE_KEY));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function saveCalibration() {
  localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(calibration));
}

function clearCalibration() {
  calibration = {};
  localStorage.removeItem(CAL_STORAGE_KEY);
}

// ── Weight calibration (raw → grams) ────────────────────────────────

const FULL_BOTTLE_G = 890; // known weight of a full beer bottle in grams

/**
 * Auto-compute gramsPerUnit from idle + put_full calibration.
 * put_full.diff = raw change when placing one full 890 g bottle.
 * gramsPerUnit = 890 / diff  (diff is negative on this sensor, so
 * gramsPerUnit will be negative → rawToGrams returns positive for
 * added weight).
 */
function isWeightCalibrated() {
  return !!(calibration['idle'] && calibration['put_full'] &&
            calibration['put_full'].diff !== 0);
}

function getGramsPerUnit() {
  if (!isWeightCalibrated()) return 0;
  return FULL_BOTTLE_G / calibration['put_full'].diff;
}

/** Convert a raw sensor value to grams (relative to tare/idle). Returns null if not calibrated. */
function rawToGrams(rawValue) {
  if (!isWeightCalibrated()) return null;
  return (rawValue - calibration['idle'].endMean) * getGramsPerUnit();
}

/** Convert a raw difference to grams. Returns null if not calibrated. */
function diffToGrams(rawDiff) {
  if (!isWeightCalibrated()) return null;
  return rawDiff * getGramsPerUnit();
}

/**
 * Capture calibration from a measured start→end change.
 * @param {string} action   One of CAL_ACTIONS
 * @param {number} startMean  Mean raw at button click
 * @param {number} endMean    Mean raw after settling
 * @param {number} sd         Stddev of end-phase frames
 */
function captureCalibration(action, startMean, endMean, sd) {
  calibration[action] = {
    diff: endMean - startMean,
    sd,
    startMean,
    endMean,
    ts: Date.now(),
  };
  saveCalibration();
  return calibration[action];
}

function calibrationCount() {
  return CAL_ACTIONS.filter(a => calibration[a]).length;
}

function isFullyCalibrated() {
  return calibrationCount() === CAL_ACTIONS.length;
}

// ── Buffer statistics ───────────────────────────────────────────────

function computeBufferStats(framesArr) {
  const third = Math.floor(framesArr.length / 3);
  const startSlice = framesArr.slice(0, third);
  const endSlice   = framesArr.slice(framesArr.length - third);
  const startMean  = mean(startSlice.map(f => f.raw));
  const endMean    = mean(endSlice.map(f => f.raw));
  const diff       = endMean - startMean;
  const sd         = stddev(framesArr.map(f => f.raw));
  return { diff, sd, startMean, endMean };
}

// ── Adaptive thresholds ─────────────────────────────────────────────

function getCalmThreshold() {
  return calibration['idle'] ? calibration['idle'].sd * 8 : DEFAULT_CALM_SD;
}
function getMoveThreshold() {
  return calibration['idle'] ? calibration['idle'].sd * 80 : DEFAULT_MOVE_SD;
}

// ── Bottle weight helpers ───────────────────────────────────────────

/**
 * Compute expected raw-unit weight for a full / empty bottle from the
 * calibration diff values (= actual weight change captured over 5 s).
 * Requires put_full at minimum.
 * Returns { fullRaw, emptyRaw } (signed, same sign as diff) or null.
 */
function getBottleWeights() {
  if (!calibration['put_full']) return null;
  const fullRaw = calibration['put_full'].diff;
  let emptyRaw = null;
  if (calibration['put_empty']) {
    emptyRaw = calibration['put_empty'].diff;
  }
  return { fullRaw, emptyRaw };
}

/** Same as getBottleWeights but converted to grams (absolute). */
function getBottleWeightsGrams() {
  const b = getBottleWeights();
  if (!b || !isWeightCalibrated()) return null;
  const gpu = getGramsPerUnit();
  return {
    fullGrams:  Math.abs(b.fullRaw  * gpu),
    emptyGrams: b.emptyRaw != null ? Math.abs(b.emptyRaw * gpu) : null,
  };
}

function weightDebugStr(rawValue) {
  const g = rawToGrams(rawValue);
  return g != null ? `${Math.abs(g).toFixed(0)} g` : '';
}

// ── Classifier (state machine) ──────────────────────────────────────

function classifyHardcode(framesArr) {
  if (framesArr.length < MIN_FRAMES) {
    return { label: 'uncertain', debug: `nur ${framesArr.length}/${MIN_FRAMES} Frames` };
  }

  // Stability metric: sd of last 5 raw values
  const recentRaws = framesArr.slice(-5).map(f => f.raw);
  const recentSd   = stddev(recentRaws);
  const latestRaw  = framesArr[framesArr.length - 1].raw;
  const calmTh     = getCalmThreshold();
  const moveTh     = getMoveThreshold();

  // Initialise baseline on first call
  if (stableBaseline === null) stableBaseline = latestRaw;

  // ── Display hold: keep confirmed label visible for a few frames ──
  if (displayCounter > 0) {
    displayCounter--;
    if (displayCounter === 0) confirmedLabel = 'idle';
    return { label: confirmedLabel, debug: `BESTÄTIGT  ${weightDebugStr(latestRaw)}` };
  }

  switch (hcState) {

    case 'stable': {
      // Use a slow-moving average for baseline (EMA α=0.1)
      stableBaseline = stableBaseline * 0.9 + latestRaw * 0.1;
      if (recentSd > moveTh) {
        hcState = 'changing';
        calmCounter = 0;
        return { label: 'Unruhe', debug: `Bewegung erkannt  sd=${recentSd.toFixed(0)}  th=${moveTh.toFixed(0)}` };
      }
      return { label: 'idle', debug: `stabil  sd=${recentSd.toFixed(0)}  ${weightDebugStr(latestRaw)}` };
    }

    case 'changing':
      if (recentSd < calmTh) {
        hcState = 'settling';
        calmCounter = 1;
        return { label: 'Unruhe', debug: `beruhigt (${calmCounter}/${SETTLE_FRAMES})  sd=${recentSd.toFixed(0)}` };
      }
      return { label: 'Unruhe', debug: `Bewegung  sd=${recentSd.toFixed(0)}` };

    case 'settling':
      if (recentSd > moveTh) {
        hcState = 'changing';
        calmCounter = 0;
        return { label: 'Unruhe', debug: `erneute Bewegung  sd=${recentSd.toFixed(0)}` };
      }
      if (recentSd < calmTh) {
        calmCounter++;
      } else {
        calmCounter = Math.max(0, calmCounter - 1);
      }
      if (calmCounter >= SETTLE_FRAMES) {
        // ── Settled → classify the weight change ──
        hcState = 'stable';
        const result = classifyWeightChange(stableBaseline, latestRaw, getHcCrateState());
        stableBaseline = latestRaw;
        confirmedLabel = result.label;
        if (confirmedLabel !== 'idle') {
          displayCounter = DISPLAY_HOLD;
        }
        return result;
      }
      return { label: 'Unruhe', debug: `beruhigt (${calmCounter}/${SETTLE_FRAMES})  sd=${recentSd.toFixed(0)}` };
  }
}

// ── Weight-change classification (multi-bottle aware) ─────────────

/**
 * Given the observed raw change and the current crate contents,
 * find the combination of bottle add/remove that best explains
 * the weight difference.
 *
 * @param {number} oldRaw
 * @param {number} newRaw
 * @param {{full:number, empty:number}} crateState  current bottles in crate
 * @returns {{ label:string, fullDelta:number, emptyDelta:number, debug:string }}
 */
function classifyWeightChange(oldRaw, newRaw, crateState) {
  const rawChange = newRaw - oldRaw;
  const absChange = Math.abs(rawChange);
  const gramsChange = isWeightCalibrated() ? diffToGrams(rawChange) : null;
  const gStr = gramsChange != null
    ? `(${gramsChange > 0 ? '+' : ''}${gramsChange.toFixed(0)} g)`
    : '';

  const bw = getBottleWeights();
  const noiseFloor = bw
    ? Math.min(Math.abs(bw.fullRaw), bw.emptyRaw != null ? Math.abs(bw.emptyRaw) : Infinity) * 0.15
    : 10000;

  if (absChange < noiseFloor) {
    return { label: 'idle', fullDelta: 0, emptyDelta: 0,
             debug: `minimale Änderung ${gStr}  Δraw=${rawChange.toFixed(0)}` };
  }

  if (!bw) {
    return { label: 'Unruhe', fullDelta: 0, emptyDelta: 0,
             debug: `Änderung ohne Kalibrierung  Δraw=${rawChange.toFixed(0)} ${gStr}` };
  }

  const { fullRaw, emptyRaw } = bw;
  const eRaw = emptyRaw != null ? emptyRaw : 0;
  const { full: curFull, empty: curEmpty } = crateState;

  // Generate plausible candidates
  // Constraints: can't remove more than present, can't exceed crate capacity.
  const maxSlots = crateCapacity;
  let bestLabel = 'Unruhe';
  let bestFullD = 0, bestEmptyD = 0;
  let bestDist  = Infinity;

  for (let fD = -maxSlots; fD <= maxSlots; fD++) {
    for (let eD = -maxSlots; eD <= maxSlots; eD++) {
      if (fD === 0 && eD === 0) continue;
      // Can't remove more than present
      if (fD < 0 && -fD > curFull) continue;
      if (eD < 0 && -eD > curEmpty) continue;
      // Can't exceed crate capacity
      const newTotal = (curFull + fD) + (curEmpty + eD);
      if (newTotal > maxSlots || newTotal < 0) continue;
      // Skip if emptyRaw is unknown and we need empty bottles
      if (eD !== 0 && emptyRaw == null) continue;

      const expected = fD * fullRaw + eD * eRaw;
      if (Math.abs(expected) < noiseFloor) continue; // skip near-zero combos
      const dist = Math.abs(rawChange - expected) / Math.abs(expected);
      if (dist < WEIGHT_TOLERANCE && dist < bestDist) {
        bestDist   = dist;
        bestFullD  = fD;
        bestEmptyD = eD;
      }
    }
  }

  if (bestDist < Infinity) {
    bestLabel = formatMultiLabel(bestFullD, bestEmptyD);

    // Validate: does the resulting count match the absolute weight?
    const validation = validateAgainstAbsoluteWeight(
      newRaw, curFull + bestFullD, curEmpty + bestEmptyD);
    if (validation) {
      // Delta result doesn't match absolute weight → override
      return validation;
    }
  } else {
    // No valid combination found within capacity — recalculate crate from
    // absolute weight relative to tare (idle.endMean).
    const recount = recountFromAbsoluteWeight(newRaw);
    if (recount) {
      return recount;
    }
  }

  const matchPct = bestDist < Infinity ? (bestDist * 100).toFixed(0) + '%' : '—';
  const detail = bestDist < Infinity
    ? `voll:${bestFullD > 0 ? '+' : ''}${bestFullD}  leer:${bestEmptyD > 0 ? '+' : ''}${bestEmptyD}`
    : '';
  return {
    label: bestLabel,
    fullDelta: bestFullD,
    emptyDelta: bestEmptyD,
    debug: `Δraw=${rawChange.toFixed(0)} ${gStr}  → ${bestLabel}  ${detail}  (abw: ${matchPct})`,
  };
}

/**
 * Validate a proposed count against the absolute weight on the sensor.
 * If the proposed count's expected weight diverges too far from actual,
 * recalculate from absolute weight instead.
 *
 * @returns result object with resetFull/resetEmpty, or null if count is OK
 */
function validateAgainstAbsoluteWeight(currentRaw, proposedFull, proposedEmpty) {
  const bw = getBottleWeights();
  if (!bw || !calibration['idle'] || bw.emptyRaw == null) return null;

  const totalRaw    = currentRaw - calibration['idle'].endMean;
  const expectedRaw = proposedFull * bw.fullRaw + proposedEmpty * bw.emptyRaw;
  const error       = Math.abs(totalRaw - expectedRaw);

  // Tolerance: half the weight of the lightest bottle type
  const tolerance = Math.min(Math.abs(bw.fullRaw), Math.abs(bw.emptyRaw)) * 0.5;
  if (error <= tolerance) return null; // count looks correct

  // Count doesn't match absolute weight → recalculate
  return recountFromAbsoluteWeight(currentRaw);
}

/**
 * Recalculate the crate contents from absolute weight.
 * Tries all (nFull, nEmpty) combos that fit in the crate capacity
 * and picks the closest match.
 */
function recountFromAbsoluteWeight(currentRaw) {
  const bw = getBottleWeights();
  if (!bw || !calibration['idle']) return null;

  const { fullRaw, emptyRaw } = bw;
  if (emptyRaw == null) return null;

  // Total weight on crate relative to tare
  const totalRaw = currentRaw - calibration['idle'].endMean;
  const maxSlots = crateCapacity;

  let bestFull = 0, bestEmpty = 0;
  let bestDist = Infinity;

  for (let nF = 0; nF <= maxSlots; nF++) {
    for (let nE = 0; nE <= maxSlots - nF; nE++) {
      const expected = nF * fullRaw + nE * emptyRaw;
      const dist = Math.abs(totalRaw - expected);
      if (dist < bestDist) {
        bestDist  = dist;
        bestFull  = nF;
        bestEmpty = nE;
      }
    }
  }

  // Sanity: the match should be somewhat close (within half a bottle)
  const halfBottle = Math.min(Math.abs(fullRaw), Math.abs(emptyRaw)) * 0.5;
  if (bestDist > halfBottle) return null;

  const grams = isWeightCalibrated() ? diffToGrams(totalRaw) : null;
  const gStr = grams != null ? `(${Math.abs(grams).toFixed(0)} g gesamt)` : '';

  return {
    label: `⚠ Korrektur: ${bestFull}× voll, ${bestEmpty}× leer`,
    fullDelta: 0,
    emptyDelta: 0,
    resetFull: bestFull,
    resetEmpty: bestEmpty,
    debug: `Zähler-Korrektur ${gStr}  → ${bestFull}V + ${bestEmpty}L  (abw: ${bestDist.toFixed(0)})`,
  };
}

/** Build a human-readable label from deltas. */
function formatMultiLabel(fD, eD) {
  const parts = [];
  if (fD > 0) parts.push(`${fD}× volle rein`);
  if (fD < 0) parts.push(`${-fD}× volle raus`);
  if (eD > 0) parts.push(`${eD}× leere rein`);
  if (eD < 0) parts.push(`${-eD}× leere raus`);
  return parts.join(' + ') || 'idle';
}

// ── Helpers ──────────────────────────────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}
