// Shared math for weighted filtrations.

/**
 * points: Array<[x,y]> where x,y in [0,1]
 * k: integer >= 0
 * returns Float32Array weights w_i (mean distance to k nearest neighbors)
 */
export function computeKnnWeights(points, k) {
  const n = points.length;
  const kk = Math.max(0, Math.min(n - 1, Math.floor(k)));
  const w = new Float32Array(n);
  if (kk <= 0) return w;

  // O(n^2 log n) for n=50 is fine.
  for (let i = 0; i < n; i++) {
    const xi = points[i][0], yi = points[i][1];
    const dists = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = xi - points[j][0];
      const dy = yi - points[j][1];
      dists.push(Math.hypot(dx, dy));
    }
    dists.sort((a, b) => a - b);
    let sum = 0;
    for (let t = 0; t < kk; t++) sum += dists[t];
    w[i] = sum / kk;
  }
  return w;
}

export function radiusAt(t, w, p) {
  // r(t) = max(t^p - w^p, 0)^(1/p)
  if (t <= 0) return 0;
  if (w <= 0) return t;
  const pp = p;
  const tp = Math.pow(t, pp);
  const wp = Math.pow(w, pp);
  const v = tp - wp;
  if (v <= 0) return 0;
  return Math.pow(v, 1 / pp);
}

/**
 * For a pair distance d, weights wi,wj, find minimal t s.t.
 * d <= r_i(t) + r_j(t), where r_i(t)=radiusAt(t, wi, p).
 * This provides an edge filtration value t_ij.
 */
export function solvePairThreshold(d, wi, wj, p) {
  if (!(d > 0)) return Math.max(wi, wj);

  const lo0 = Math.max(wi, wj);
  let lo = lo0;
  let hi = lo0;

  const sumR = (t) => radiusAt(t, wi, p) + radiusAt(t, wj, p);

  // ensure hi large enough
  let sr = sumR(hi);
  if (sr >= d) return hi;

  // Exponential / additive growth to find an upper bound.
  // (The radii grow ~ linearly with t, so O(log) steps.)
  for (let iter = 0; iter < 60 && sr < d; iter++) {
    const step = Math.max(d, 1e-6);
    hi = Math.max(hi * 2, hi + step);
    sr = sumR(hi);
  }

  // Binary search
  for (let iter = 0; iter < 42; iter++) {
    const mid = 0.5 * (lo + hi);
    if (sumR(mid) >= d) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Build full n*n distance matrix (Float32Array) of edge filtration values.
 * dist[i*n+j] = t_ij, dist[i*n+i] = 0.
 */
export function buildWeightedDistanceMatrix(points, k, p) {
  const n = points.length;
  const w = computeKnnWeights(points, k);
  const dist = new Float32Array(n * n);

  for (let i = 0; i < n; i++) {
    dist[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const dx = points[i][0] - points[j][0];
      const dy = points[i][1] - points[j][1];
      const d = Math.hypot(dx, dy);
      const tij = solvePairThreshold(d, w[i], w[j], p);
      dist[i * n + j] = tij;
      dist[j * n + i] = tij;
    }
  }
  return { dist, w };
}
