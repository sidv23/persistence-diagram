import { euclid, computeWeightsKNN, edgeTimeForDistance } from './weighted-math3.js';

self.onmessage = (ev) => {
  const { id, points, maxdim, k, p } = ev.data;
  const result = computeVRPersistence(points, Math.min(1, maxdim ?? 1), k ?? 0, p ?? 1);
  self.postMessage({ id, ...result });
};

function computeVRPersistence(pts, maxdim, k, p) {
  const n = pts.length;

  const weights = computeWeightsKNN(pts, k);
  const dist = new Float32Array(n * n);

  for (let i = 0; i < n; i++) {
    dist[i * n + i] = 0;
    for (let j = i + 1; j < n; j++) {
      const d = euclid(pts[i], pts[j]);
      const t = edgeTimeForDistance(d, weights[i], weights[j], p);
      dist[i * n + j] = t;
      dist[j * n + i] = t;
    }
  }

  const simplices = [];
  for (let i = 0; i < n; i++) simplices.push({ dim: 0, v: [i], f: 0 });

  let maxF = 0;

  // edges
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const t = dist[i * n + j];
      if (t > maxF) maxF = t;
      simplices.push({ dim: 1, v: [i, j], f: t });
    }
  }

  // triangles
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const tij = dist[i * n + j];
      for (let k3 = j + 1; k3 < n; k3++) {
        const tik = dist[i * n + k3];
        const tjk = dist[j * n + k3];
        const f = Math.max(tij, tik, tjk);
        if (f > maxF) maxF = f;
        simplices.push({ dim: 2, v: [i, j, k3], f });
      }
    }
  }

  simplices.sort((a, b) => {
    if (a.f !== b.f) return a.f - b.f;
    if (a.dim !== b.dim) return a.dim - b.dim;
    const av = a.v, bv = b.v;
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
    return 0;
  });

  const m = simplices.length;
  const dims = new Uint8Array(m);
  const filt = new Float32Array(m);

  const vertexPos = new Int32Array(n);
  const edgePos = new Int32Array(n * n);
  edgePos.fill(-1);

  for (let idx = 0; idx < m; idx++) {
    const s = simplices[idx];
    dims[idx] = s.dim;
    filt[idx] = s.f;

    if (s.dim === 0) vertexPos[s.v[0]] = idx;
    else if (s.dim === 1) {
      const [i, j] = s.v;
      edgePos[i * n + j] = idx;
      edgePos[j * n + i] = idx;
    }
  }

  const boundaries = new Array(m);
  for (let idx = 0; idx < m; idx++) {
    const s = simplices[idx];
    if (s.dim === 0) boundaries[idx] = [];
    else if (s.dim === 1) {
      const [i, j] = s.v;
      const a = vertexPos[i], b = vertexPos[j];
      boundaries[idx] = a < b ? [a, b] : [b, a];
    } else {
      const [i, j, k3] = s.v;
      const arr = [edgePos[i * n + j], edgePos[i * n + k3], edgePos[j * n + k3]];
      arr.sort((x, y) => x - y);
      boundaries[idx] = arr;
    }
  }

  const lowToCol = new Map();
  const reduced = new Array(m);

  const H0 = [];
  const H1 = [];

  for (let j = 0; j < m; j++) {
    const bj = boundaries[j];
    if (bj.length === 0) {
      reduced[j] = [];
      continue;
    }

    let col = bj.slice();

    while (col.length > 0) {
      const low = col[col.length - 1];
      const pivotCol = lowToCol.get(low);
      if (pivotCol === undefined) break;
      col = xorSorted(col, reduced[pivotCol]);
    }

    if (col.length === 0) {
      reduced[j] = [];
      continue;
    }

    const low = col[col.length - 1];
    lowToCol.set(low, j);
    reduced[j] = col;

    const dr = dims[low];
    if (dr === 0) H0.push([filt[low], filt[j]]);
    else if (dr === 1 && maxdim >= 1) H1.push([filt[low], filt[j]]);
  }

  const maxVal = Math.max(1e-6, maxF) * 1.05;
  return { H0, H1, maxVal };
}

function xorSorted(a, b) {
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i], y = b[j];
    if (x === y) { i++; j++; }
    else if (x < y) { out.push(x); i++; }
    else { out.push(y); j++; }
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
