import { computeWeightsKNN, radiusAt } from './weighted-math3.js';

// ---------- constants ----------
const N = 50;
const MARGIN = 0.04; // normalized clamp margin
const R = 6.5;
const PICK_R = 16;

const COLORS = {
  bg: '#ffffff',
  grid: 'rgba(0,0,0,0.06)',
  frame: 'rgba(0,0,0,0.20)',
  text: 'rgba(0,0,0,0.85)',
  muted: 'rgba(0,0,0,0.55)',
  h0: '#2563eb',
  h1: '#f97316',
  point: '#111827',
  pointStroke: 'rgba(255,255,255,0.9)',
  select: '#10b981',
  ball: '#fdba74',
};

// ---------- points ----------
let points = makeCirclePoints(N, MARGIN);

// ---------- DOM ----------
const ptsBox = document.getElementById('ptsBox');
const pdBox = document.getElementById('pdBox');
const ptsCanvas = document.getElementById('pts');
const pdCanvas = document.getElementById('pd');
const ptsCtx = ptsCanvas.getContext('2d', { alpha: false });
const pdCtx = pdCanvas.getContext('2d', { alpha: false });

const tSlider = document.getElementById('tSlider');
const tVal = document.getElementById('tVal');
const kInput = document.getElementById('kInput');
const pInput = document.getElementById('pInput');
const resetBtn = document.getElementById('resetBtn');


// square size in CSS pixels
let sizePx = 600;
let dpr = 1;

// slider-driven threshold in CSS pixels
let tPx = 0;

// weighting params
let kVal = Math.max(0, Number(kInput.value) | 0);
let pVal = Math.max(1e-6, Number(pInput.value) || 1);

// ---------- Worker ----------
const worker = new Worker('./ph-worker3.js', { type: 'module' });

let latestReqId = 0;
let computeInFlight = false;
let computeQueued = false;
let lastResult = { H0: [], H1: [], maxVal: 1 };

// ---------- High-DPI canvas sizing ----------
function resizeCanvasToBox(canvas, ctx, box) {
  const rect = box.getBoundingClientRect();
  const s = Math.floor(Math.min(rect.width, rect.height));
  sizePx = Math.max(220, s);

  dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  canvas.style.width = `${sizePx}px`;
  canvas.style.height = `${sizePx}px`;
  canvas.width = Math.floor(sizePx * dpr);
  canvas.height = Math.floor(sizePx * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
}

function resizeAll() {
  resizeCanvasToBox(ptsCanvas, ptsCtx, ptsBox);
  resizeCanvasToBox(pdCanvas, pdCtx, pdBox);

  // Slider range: 0 to half the canvas width (CSS pixels)
  const maxTPx = Math.floor(sizePx / 2);
  tSlider.max = String(maxTPx);

  tPx = Math.max(0, Math.min(maxTPx, tPx));
  tSlider.value = String(Math.round(tPx));
  tVal.textContent = (tPx / 200).toPrecision(3);
}

const ro = new ResizeObserver(() => {
  resizeAll();
  drawAll();
});
ro.observe(ptsBox);
ro.observe(pdBox);

resetBtn.addEventListener('click', () => {
  points = makeCirclePoints(N, MARGIN);   // same init conditions (baseR/sigma inside)
  dragging = { idx: -1, active: false };
  drawAll();
  requestCompute(); // recompute persistence for the new sample
});

// slider input (no persistence recompute)
tSlider.addEventListener('input', () => {
  tPx = Number(tSlider.value);
  tVal.textContent = (tPx / 200).toPrecision(2);
  drawAll();
});

kInput.addEventListener('change', () => {
  kVal = Math.max(0, Number(kInput.value) | 0);
  requestCompute();
  drawAll();
});

pInput.addEventListener('change', () => {
  const v = Number(pInput.value);
  pVal = Number.isFinite(v) && v > 0 ? v : 1;
  requestCompute();
  drawAll();
});

// ---------- utilities ----------
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function normToPx(p) {
  return { x: p.x * sizePx, y: p.y * sizePx };
}

function pxToNorm(x, y) {
  return { x: clamp01(x / sizePx), y: clamp01(y / sizePx) };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawGrid(ctx) {
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, sizePx, sizePx);

  const step = sizePx / 10;
  ctx.lineWidth = 1;
  ctx.strokeStyle = COLORS.grid;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) {
    const x = i * step;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, sizePx);
    ctx.moveTo(0, x);
    ctx.lineTo(sizePx, x);
  }
  ctx.stroke();
}

// ---------- point cloud interaction ----------
let dragging = { idx: -1, active: false };

function findClosestPoint(px, py) {
  let best = -1;
  let bestD2 = PICK_R * PICK_R;
  for (let i = 0; i < points.length; i++) {
    const p = normToPx(points[i]);
    const dx = p.x - px;
    const dy = p.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

ptsCanvas.addEventListener('pointerdown', (e) => {
  const rect = ptsCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  const idx = findClosestPoint(px, py);
  if (idx >= 0) {
    dragging = { idx, active: true };
    ptsCanvas.setPointerCapture(e.pointerId);
    drawAll();
  }
});

ptsCanvas.addEventListener('pointermove', (e) => {
  if (!dragging.active) return;

  const rect = ptsCanvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  let p = pxToNorm(px, py);
  p.x = Math.max(MARGIN, Math.min(1 - MARGIN, p.x));
  p.y = Math.max(MARGIN, Math.min(1 - MARGIN, p.y));
  points[dragging.idx] = p;

  drawAll();
  requestCompute();
});

function endDrag(e) {
  if (!dragging.active) return;
  dragging.active = false;
  try { ptsCanvas.releasePointerCapture(e.pointerId); } catch { }
  drawAll();
}

ptsCanvas.addEventListener('pointerup', endDrag);
ptsCanvas.addEventListener('pointercancel', endDrag);

// ---------- persistence computation scheduling ----------
function requestCompute() {
  computeQueued = true;
  pumpCompute();
}

function pumpCompute() {
  if (!computeQueued || computeInFlight) return;
  computeQueued = false;
  computeInFlight = true;

  const id = ++latestReqId;
  const payload = points.map((p) => [p.x, p.y]);
  worker.postMessage({ id, points: payload, maxdim: 1, k: kVal, p: pVal });
}

worker.onmessage = (ev) => {
  const { id, H0, H1, maxVal } = ev.data;
  if (id !== latestReqId) return;

  lastResult = { H0, H1, maxVal: Math.max(1e-6, maxVal) };
  computeInFlight = false;

  drawAll();
  pumpCompute();
};

// ---------- legend (bottom-right) ----------
function drawLegendBottomRight(ctx, frameRight, frameBottom) {
  const pad = 10;
  const font = '12px system-ui, sans-serif';
  const line1 = 'components (H0)';
  const line2 = 'loops (H1)';

  ctx.save();
  ctx.font = font;

  const textW = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
  const w = Math.ceil(textW + 52);
  const h = 56;

  const x = frameRight - w - pad;
  const y = frameBottom - h - pad;

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();
  ctx.stroke();

  ctx.font = font;
  ctx.fillStyle = COLORS.text;

  // components (H0) filled marker
  ctx.beginPath();
  ctx.fillStyle = COLORS.h0;
  ctx.arc(x + 16, y + 19, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.fillText(line1, x + 30, y + 23);

  // loops (H1) hollow marker
  ctx.beginPath();
  ctx.strokeStyle = COLORS.h1;
  ctx.lineWidth = 2;
  ctx.arc(x + 16, y + 40, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = COLORS.text;
  ctx.fillText(line2, x + 30, y + 44);

  ctx.restore();
}

// ---------- drawing ----------
function drawPointCloud() {
  const ctx = ptsCtx;
  drawGrid(ctx);

  // frame
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.frame;
  ctx.strokeRect(10, 10, sizePx - 20, sizePx - 20);

  // clip balls to the inner frame
  ctx.save();
  ctx.beginPath();
  ctx.rect(10, 10, sizePx - 20, sizePx - 20);
  ctx.clip();

  const tNorm = sizePx > 0 ? (tPx / sizePx) : 0;
  const weights = computeWeightsKNN(points.map((p) => [p.x, p.y]), kVal);

  if (tNorm > 0) {
    ctx.fillStyle = COLORS.ball;
    for (let i = 0; i < points.length; i++) {
      const p = normToPx(points[i]);
      const rNorm = radiusAt(tNorm, weights[i], pVal);
      const rPx = rNorm * sizePx;
      if (rPx <= 0) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rPx, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  // points on top
  for (let i = 0; i < points.length; i++) {
    const p = normToPx(points[i]);
    const isSel = dragging.active && i === dragging.idx;

    ctx.beginPath();
    ctx.arc(p.x, p.y, R + 2.2, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? 'rgba(16,185,129,0.18)' : 'rgba(0,0,0,0.08)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? COLORS.select : COLORS.point;
    ctx.fill();

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.pointStroke;
    ctx.stroke();
  }
}

function drawPersistenceDiagram() {
  const ctx = pdCtx;
  drawGrid(ctx);

  const m = 52;
  const inner = sizePx - 2 * m;

  // frame
  ctx.lineWidth = 2;
  ctx.strokeStyle = COLORS.frame;
  ctx.strokeRect(m, m, inner, inner);

  // diagonal
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.moveTo(m, m + inner);
  ctx.lineTo(m + inner, m);
  ctx.stroke();

  // ticks + labels
  const ticks = 5;
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.fillStyle = COLORS.muted;
  ctx.font = '11px system-ui, sans-serif';

  for (let i = 1; i < ticks; i++) {
    const t = i / ticks;
    const x = m + t * inner;

    ctx.beginPath();
    ctx.moveTo(x, m + inner);
    ctx.lineTo(x, m + inner + 6);
    ctx.stroke();
    ctx.fillText(t.toFixed(1), x - 8, m + inner + 20);

    const yy = m + inner - t * inner;
    ctx.beginPath();
    ctx.moveTo(m - 6, yy);
    ctx.lineTo(m, yy);
    ctx.stroke();
    ctx.fillText(t.toFixed(1), 10, yy + 4);
  }

  ctx.fillStyle = COLORS.text;
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText('birth', m + inner / 2 - 16, sizePx - 16);
  ctx.save();
  ctx.translate(18, m + inner / 2 + 18);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('death', 0, 0);
  ctx.restore();

  const { H0, H1, maxVal } = lastResult;

  function toXY(b, d) {
    const x = m + (b / maxVal) * inner;
    const y = m + inner - (d / maxVal) * inner;
    return [x, y];
  }

  // consistent marker sizes
  const r0 = 3.0;
  const r1 = 3.0;

  // components (H0)
  ctx.fillStyle = COLORS.h0;
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (const [b, d] of H0) {
    const [x, y] = toXY(b, d);
    ctx.beginPath();
    ctx.arc(x, y, r0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // loops (H1)
  ctx.strokeStyle = COLORS.h1;
  ctx.lineWidth = 2;
  for (const [b, d] of H1) {
    const [x, y] = toXY(b, d);
    ctx.beginPath();
    ctx.arc(x, y, r1, 0, Math.PI * 2);
    ctx.stroke();
  }

  // dotted reflected L-shape at threshold t (in the same units as the filtration)
  const tNorm = sizePx > 0 ? (tPx / sizePx) : 0;
  const tt = Math.max(0, Math.min(maxVal, tNorm));
  const xT = m + (tt / maxVal) * inner;
  const yT = m + inner - (tt / maxVal) * inner;

  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';

  // horizontal to the diagonal
  ctx.beginPath();
  ctx.moveTo(m, yT);
  ctx.lineTo(xT, yT);
  ctx.stroke();

  // vertical from diagonal upward
  ctx.beginPath();
  ctx.moveTo(xT, yT);
  ctx.lineTo(xT, m);
  ctx.stroke();

  ctx.restore();

  drawLegendBottomRight(ctx, m + inner, m + inner);
}

function drawAll() {
  drawPointCloud();
  drawPersistenceDiagram();
}

// ---------- circle init + radial Gaussian noise ----------
function makeCirclePoints(n, margin) {
  const pts = [];
  const cx = 0.5, cy = 0.5;
  const baseR = 0.34;
  const sigma = 0.03;

  for (let i = 0; i < n; i++) {
    const theta = (2 * Math.PI * i) / n;
    const r = baseR + sigma * randn();
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    pts.push({
      x: Math.max(margin, Math.min(1 - margin, x)),
      y: Math.max(margin, Math.min(1 - margin, y)),
    });
  }

  // shuffle
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  return pts;
}

// Box–Muller
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- boot ----------
resizeAll();
drawAll();
requestCompute();
