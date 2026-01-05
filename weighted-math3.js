// Shared math for the weighted ball filtration.
//
// Convention (matches the linked filtrations/script.js logic):
// - Points are in normalized coordinates [0,1]^2.
// - For a given threshold t (normalized), each point i has weight w_i (normalized).
// - The displayed ball radius is r_i(t) = max(t^p - w_i^p, 0)^(1/p).
// - For persistence, we build a matrix D where D_ij is the smallest t such that
//   ||x_i-x_j|| <= r_i(t) + r_j(t). Feeding D into VR yields a filtration in the same
//   't' units as the slider.

export function euclid(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.hypot(dx, dy);
}

export function computeWeightsKNN(points, k) {
  // k = number of neighbors to average. If k <= 0, weights are 0.
  const n = points.length;
  const w = new Float32Array(n);
  if (k <= 0) return w;

  for (let i = 0; i < n; i++) {
    const dists = [];
    const pi = points[i];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      dists.push(euclid(pi, points[j]));
    }
    dists.sort((a, b) => a - b);
    const kk = Math.min(k, dists.length);
    let sum = 0;
    for (let m = 0; m < kk; m++) sum += dists[m];
    w[i] = sum / kk;
  }
  return w;
}

export function radiusAt(t, w, p) {
  if (t <= 0) return 0;
  if (p <= 0) return 0;
  const tp = Math.pow(t, p);
  const wp = Math.pow(Math.max(0, w), p);
  const v = tp - wp;
  if (v <= 0) return 0;
  return Math.pow(v, 1 / p) * 1.05;
}

export function edgeTimeForDistance(d, wi, wj, p) {
  // Returns smallest t >= 0 such that radiusAt(t,wi,p)+radiusAt(t,wj,p) >= d.
  // For wi=wj=0,p=1: returns d/2.

  if (d <= 0) return 0;
  const wmax = Math.max(0, wi, wj);

  // Quick path: unweighted common case
  if (wmax === 0 && p === 1) return 0.5 * d;

  const f = (t) => radiusAt(t, wi, p) + radiusAt(t, wj, p) - d;

  let lo = wmax;
  let hi = wmax + d; // safe start

  // Expand hi if needed
  let flo = f(lo);
  if (flo >= 0) return lo;

  let fhi = f(hi);
  let it = 0;
  while (fhi < 0 && it < 40) {
    hi *= 2;
    fhi = f(hi);
    it++;
  }

  // Bisection
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    const fm = f(mid);
    if (fm >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function buildWeightedTimeMatrix(points, k, p) {
  const n = points.length;
  const w = computeWeightsKNN(points, k);
  const D = new Float32Array(n * n);
  let maxT = 0;

  for (let i = 0; i < n; i++) {
    D[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const d = euclid(points[i], points[j]);
      const tij = edgeTimeForDistance(d, w[i], w[j], p);
      D[i * n + j] = tij;
      D[j * n + i] = tij;
      if (tij > maxT) maxT = tij;
    }
  }

  return { D, w, maxT };
}
