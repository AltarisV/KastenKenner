/**
 * chart.js — Lightweight rolling chart drawn on a <canvas>.
 *
 * Plots two series:
 *   • raw   → orange
 *   • delta → green
 *
 * The chart auto-scales its Y axis to the visible min/max.
 */

const CHART_MAX_POINTS = 120;   // how many data points to keep on screen
const CHART_PAD = 32;           // px padding for axis labels

const chartState = {
  rawData:   [],
  deltaData: [],
};

/**
 * Push a new sample and redraw.
 * @param {number} raw
 * @param {number} delta
 */
function chartPush(raw, delta) {
  chartState.rawData.push(raw);
  chartState.deltaData.push(delta);

  if (chartState.rawData.length > CHART_MAX_POINTS) {
    chartState.rawData.shift();
    chartState.deltaData.shift();
  }

  chartDraw();
}

/** Clear all chart data and redraw (blank). */
function chartClear() {
  chartState.rawData.length = 0;
  chartState.deltaData.length = 0;
  chartDraw();
}

/** Render the chart onto #chart canvas. */
function chartDraw() {
  const canvas = document.getElementById('chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);

  const allVals = [...chartState.rawData, ...chartState.deltaData];
  if (allVals.length === 0) return;

  let minY = Math.min(...allVals);
  let maxY = Math.max(...allVals);
  if (minY === maxY) { minY -= 1; maxY += 1; }

  const plotW = W - CHART_PAD * 2;
  const plotH = H - CHART_PAD * 2;

  // helper: data index → canvas x
  const xOf = (i, len) => CHART_PAD + (i / Math.max(len - 1, 1)) * plotW;
  // helper: value → canvas y (inverted)
  const yOf = (v) => CHART_PAD + plotH - ((v - minY) / (maxY - minY)) * plotH;

  // Axes
  ctx.strokeStyle = '#334';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CHART_PAD, CHART_PAD);
  ctx.lineTo(CHART_PAD, H - CHART_PAD);
  ctx.lineTo(W - CHART_PAD, H - CHART_PAD);
  ctx.stroke();

  // Y labels
  ctx.fillStyle = '#888';
  ctx.font = '11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(formatNum(maxY), CHART_PAD - 4, CHART_PAD + 4);
  ctx.fillText(formatNum(minY), CHART_PAD - 4, H - CHART_PAD + 4);

  // Draw series
  drawSeries(ctx, chartState.rawData,   '#ff9800', xOf, yOf);  // orange
  drawSeries(ctx, chartState.deltaData, '#4caf50', xOf, yOf);  // green

  // Legend
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#ff9800';
  ctx.textAlign = 'left';
  ctx.fillText('● raw', W - 130, CHART_PAD + 4);
  ctx.fillStyle = '#4caf50';
  ctx.fillText('● delta', W - 70, CHART_PAD + 4);
}

function drawSeries(ctx, data, color, xOf, yOf) {
  if (data.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xOf(0, data.length), yOf(data[0]));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xOf(i, data.length), yOf(data[i]));
  }
  ctx.stroke();
}

function formatNum(n) {
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return n.toFixed(0);
}
